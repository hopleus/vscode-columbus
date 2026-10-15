import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { Server, utils } from 'ssh2';
import type { ParsedKey } from 'ssh2';
import { TRUST, parseUrl } from '../drivers/connection';
import type { ConnectionConfig, DriverKind, SslMode } from '../drivers/connection';
import { RedisDriver } from '../drivers/redis';
import { RemoteDriver, RemoteRedis } from '../drivers/remote';
import { open } from '../drivers/ssh';
import { clusterTransactions, failover, read, reshard } from './topology';

const PRIVATE_NAME = /^(node-\d+|redis-[a-z]+|db-[a-z]+)$/;
const userKeys: ParsedKey[] = [];
const keys = mkdtempSync(join(tmpdir(), 'columbus-keys-'));
const sessions = new Set<{ end(): void }>();
let ssh: Server;
let echo: TcpServer;
let sshPort = 0;
let echoPort = 0;
const opened: { close(): void }[] = [];

const listen = (server: { listen(port: number, host: string, done: () => void): unknown; address(): unknown }): Promise<number> =>
	new Promise(done => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));

before(async () => {
	const key = keyPair();
	ssh = new Server({ hostKeys: [key.private] }, client => {
		sessions.add(client);
		client.on('close', () => sessions.delete(client));
		client.on('authentication', context => {
			if (context.method === 'password' && context.username === 'tunnel' && context.password === 'secret') {
				context.accept();
				return;
			}
			if (context.method === 'publickey' && context.username === 'tunnel') {
				const known = userKeys.find(key => key.type === context.key.algo && key.getPublicSSH().equals(context.key.data));
				if (known && (!context.signature || known.verify(context.blob!, context.signature, context.hashAlgo) === true)) {
					context.accept();
					return;
				}
			}
			context.reject(['password', 'publickey']);
		});
		client.on('ready', () => {
			client.on('tcpip', (accept, reject, info) => {
				const upstream = connect(info.destPort, PRIVATE_NAME.test(info.destIP) ? '127.0.0.1' : info.destIP, () => {
					const stream = accept();
					stream.pipe(upstream).pipe(stream);
				});
				upstream.on('error', () => reject());
			});
		});
		client.on('error', () => undefined);
	});
	echo = createServer(socket => socket.pipe(socket));
	sshPort = await listen(ssh);
	echoPort = await listen(echo);
});

after(() => {
	for (const tunnel of opened) {
		tunnel.close();
	}
	ssh.close();
	echo.close();
	rmSync(keys, { recursive: true, force: true });
});

const target = (extra: Partial<NonNullable<ConnectionConfig['ssh']>> = {}): ConnectionConfig => ({
	driver: 'postgres', host: '127.0.0.1', port: echoPort, database: '', user: '', password: '', ssl: 'disable',
	ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password', password: 'secret', ...extra },
});

async function trusted(): Promise<string> {
	const error = await open(target()).then(() => undefined, (err: Error) => err);
	const match = TRUST.exec(error?.message ?? '');
	assert.ok(match, error?.message);
	return match[4];
}

test('an unknown host key is offered for trust', async () => {
	const error = await open(target()).then(() => undefined, (err: Error) => err);
	assert.match(error?.message ?? '', /^SSH host 127\.0\.0\.1:\d+ is not trusted yet \(key SHA256:[\w+/]+\)$/);
	assert.equal(TRUST.exec(error!.message)?.[3], undefined);
});

test('a trusted tunnel forwards bytes to the database host', async () => {
	const tunnel = await open(target({ fingerprint: await trusted() }));
	opened.push(tunnel);
	const reply = await new Promise<string>((done, fail) => {
		const socket = connect(tunnel.port, tunnel.host, () => socket.write('ping'));
		socket.once('data', data => {
			socket.destroy();
			done(String(data));
		});
		socket.once('error', fail);
	});
	assert.equal(reply, 'ping');
});

test('a changed host key and a wrong password are reported', async () => {
	const changed = await open(target({ fingerprint: 'SHA256:other' })).then(() => undefined, (err: Error) => err);
	assert.equal(TRUST.exec(changed?.message ?? '')?.[3], 'changed');
	await assert.rejects(open(target({ fingerprint: await trusted(), password: 'wrong' })), /^Error: SSH 127\.0\.0\.1:\d+: All configured authentication methods failed/);
});

const url = process.env.COLUMBUS_PG_URL;
const ready = url && existsSync(resolve('out/drivers/ssh.js')) && existsSync(resolve('out/drivers/postgres.js'));

test('the worker reaches PostgreSQL through the tunnel after the host is trusted', { skip: ready ? false : 'set COLUMBUS_PG_URL and run npm run build' }, async () => {
	const database = parseUrl('postgres', url!);
	const config: ConnectionConfig = { ...database, ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password', password: 'secret' } };
	const asked: string[] = [];
	const remote = new RemoteDriver('postgres', resolve('out/worker.js'), async () => resolve('out/drivers/postgres.js'), async () => config, undefined, {
		tunnel: async () => resolve('out/drivers/ssh.js'),
		trust: async (host, fingerprint) => {
			asked.push(host);
			config.ssh = { ...config.ssh!, fingerprint };
			return true;
		},
	});
	try {
		assert.match(await remote.version(), /^PostgreSQL \d+/);
		assert.deepEqual(asked, [`127.0.0.1:${sshPort}`]);
	} finally {
		remote.dispose();
	}
});

test('a database the SSH host cannot reach is named in the error', { skip: ready ? false : 'set COLUMBUS_PG_URL and run npm run build' }, async () => {
	const config: ConnectionConfig = { ...parseUrl('postgres', url!), host: '127.0.0.1', port: 1, ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password', password: 'secret', fingerprint: await trusted() } };
	const remote = new RemoteDriver('postgres', resolve('out/worker.js'), async () => resolve('out/drivers/postgres.js'), async () => config, undefined, {
		tunnel: async () => resolve('out/drivers/ssh.js'),
	});
	try {
		await assert.rejects(remote.version(), new RegExp(`\\(SSH 127\\.0\\.0\\.1:${sshPort} cannot reach 127\\.0\\.0\\.1:1: Channel open failure\\)$`));
	} finally {
		remote.dispose();
	}
});

test('the worker opens the tunnel again after the SSH connection drops', { skip: ready ? false : 'set COLUMBUS_PG_URL and run npm run build' }, async () => {
	const config: ConnectionConfig = { ...parseUrl('postgres', url!), ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password', password: 'secret', fingerprint: await trusted() } };
	const states: boolean[] = [];
	const remote = new RemoteDriver('postgres', resolve('out/worker.js'), async () => resolve('out/drivers/postgres.js'), async () => config, connected => states.push(connected), {
		tunnel: async () => resolve('out/drivers/ssh.js'),
	});
	try {
		assert.match(await remote.version(), /^PostgreSQL \d+/);
		const running = remote.execute('select pg_sleep(5)', 'console');
		for (const session of sessions) {
			session.end();
		}
		await assert.rejects(running, new RegExp(`^Error: SSH connection to 127\\.0\\.0\\.1:${sshPort} was closed`));
		assert.match(await remote.version(), /^PostgreSQL \d+/);
		assert.deepEqual(states, [true, false, true]);
	} finally {
		remote.dispose();
	}
});

test('a tunnel that could not be opened is tried again on the next request', { skip: ready ? false : 'set COLUMBUS_PG_URL and run npm run build' }, async () => {
	let gate: TcpServer | undefined;
	const sockets = new Set<Socket>();
	const open = (port: number): Promise<number> => new Promise(done => {
		gate = createServer(socket => {
			const upstream = connect(sshPort, '127.0.0.1');
			for (const end of [socket, upstream]) {
				sockets.add(end);
				end.on('error', () => undefined);
				end.on('close', () => {
					socket.destroy();
					upstream.destroy();
				});
			}
			socket.pipe(upstream).pipe(socket);
		});
		gate.listen(port, '127.0.0.1', () => done((gate!.address() as AddressInfo).port));
	});
	const port = await open(0);
	gate!.close();
	const config: ConnectionConfig = { ...parseUrl('postgres', url!), ssh: { host: '127.0.0.1', port, user: 'tunnel', auth: 'password', password: 'secret', fingerprint: await trusted() } };
	const remote = new RemoteDriver('postgres', resolve('out/worker.js'), async () => resolve('out/drivers/postgres.js'), async () => config, undefined, {
		tunnel: async () => resolve('out/drivers/ssh.js'),
	});
	try {
		await assert.rejects(remote.version(), new RegExp(`^Error: SSH 127\\.0\\.0\\.1:${port}: connect ECONNREFUSED`));
		await open(port);
		assert.match(await remote.version(), /^PostgreSQL \d+/);
	} finally {
		remote.dispose();
		gate?.close();
		for (const socket of sockets) {
			socket.destroy();
		}
	}
});

const TLS_SERVERS: [DriverKind, string | undefined][] = [
	['postgres', process.env.COLUMBUS_TLS_PG_URL],
	['mysql', process.env.COLUMBUS_TLS_MYSQL_URL],
	['redis', process.env.COLUMBUS_TLS_REDIS_URL],
];

for (const [driver, tlsUrl] of TLS_SERVERS) {
	test(`${driver}: TLS behind SSH checks the certificate against the database host name`, { skip: (!tlsUrl || !existsSync(resolve(`out/drivers/${driver}.js`))) && 'start test/tls.sh, set its variables and run npm run build' }, async () => {
		const fingerprint = await trusted();
		const version = async (host: string, ssl: SslMode): Promise<string> => {
			const config: ConnectionConfig = { ...parseUrl(driver, tlsUrl!), host, ssl, sslCa: process.env.COLUMBUS_TLS_CA, ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password', password: 'secret', fingerprint } };
			const extras = { tunnel: async () => resolve('out/drivers/ssh.js') };
			const remote = driver === 'redis'
				? new RemoteRedis(resolve('out/worker.js'), async () => resolve('out/drivers/redis.js'), async () => config, undefined, extras)
				: new RemoteDriver(driver, resolve('out/worker.js'), async () => resolve(`out/drivers/${driver}.js`), async () => config, undefined, extras);
			try {
				return await remote.version();
			} finally {
				remote.dispose();
			}
		};
		assert.match(await version('db-secure', 'verify-full'), /\d/);
		await assert.rejects(version('db-impostor', 'verify-full'), /db-impostor.*altnames|altnames.*db-impostor/);
		assert.match(await version('db-impostor', 'verify-ca'), /\d/);
	});
}

const clusterBehind = process.env.COLUMBUS_SSH_REDIS_CLUSTER_URL;
const sentinelBehind = process.env.COLUMBUS_SSH_REDIS_SENTINEL_URL;

async function behindTunnel(url: string, run: (driver: RedisDriver) => Promise<void>): Promise<void> {
	const parsed = parseUrl('redis', url);
	const config = { ...parsed, servername: parsed.host, sslCa: process.env.COLUMBUS_TOPOLOGY_CA, ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password' as const, password: 'secret', fingerprint: await trusted() } };
	const tunnel = await open(config);
	opened.push(tunnel);
	const driver = new RedisDriver(config, { forward: tunnel.forward });
	try {
		await run(driver);
	} finally {
		driver.dispose();
	}
}

test('a cluster behind SSH reaches every node through its own forward', { skip: !clusterBehind && 'set COLUMBUS_SSH_REDIS_CLUSTER_URL' }, async () => {
	await behindTunnel(clusterBehind!, async cluster => {
		const names = Array.from({ length: 12 }, (_, i) => `columbus:ssh:${i}`);
		for (const name of names) {
			await cluster.batch(0, [['SET', name, name]]);
		}
		assert.equal((await cluster.scan(0, 'columbus:ssh:*', 100)).keys.length, 12);
		assert.deepEqual((await cluster.value(0, 'columbus:ssh:5', 1)), { type: 'string', value: 'columbus:ssh:5', binary: false, ttl: -1 });
		for (const name of names) {
			await cluster.batch(0, [['DEL', name]]);
		}
	});
});

test('the console runs cluster transactions behind SSH', { skip: !clusterBehind && 'set COLUMBUS_SSH_REDIS_CLUSTER_URL' }, async () => {
	await behindTunnel(clusterBehind!, async cluster => {
		await behindTunnel(clusterBehind!, other => clusterTransactions(cluster, other));
	});
});

test('Sentinel behind SSH hands out a master that is reached through the tunnel', { skip: !sentinelBehind && 'set COLUMBUS_SSH_REDIS_SENTINEL_URL' }, async () => {
	await behindTunnel(sentinelBehind!, async watched => {
		await watched.batch(2, [['SET', 'columbus:ssh:sentinel', 'ok']]);
		assert.deepEqual((await watched.scan(2, 'columbus:ssh:*', 10)).keys.map(k => k.name), ['columbus:ssh:sentinel']);
		await watched.batch(2, [['DEL', 'columbus:ssh:sentinel']]);
	});
});

const failoverBehind = process.env.COLUMBUS_SSH_REDIS_FAILOVER_URL;

test('a Sentinel failover behind SSH moves writes to the promoted master', { skip: !failoverBehind && 'set COLUMBUS_SSH_REDIS_FAILOVER_URL' }, async () => {
	await behindTunnel(failoverBehind!, async watched => {
		await watched.batch(0, [['SET', 'columbus:ssh:failover', 'before']]);
		const promoted = await failover(parseUrl('redis', failoverBehind!).port, 'mymaster');
		await watched.batch(0, [['SET', 'columbus:ssh:failover', 'after']]);
		assert.deepEqual(await read(promoted, 'columbus:ssh:failover'), { role: 'master', value: 'after' });
		await watched.batch(0, [['DEL', 'columbus:ssh:failover']]);
	});
});

const tlsBehind = process.env.COLUMBUS_SSH_REDIS_TLS_CLUSTER_URL;

test('a TLS cluster behind SSH checks each node against its own name', { skip: !tlsBehind && 'set COLUMBUS_SSH_REDIS_TLS_CLUSTER_URL and COLUMBUS_TOPOLOGY_CA' }, async () => {
	await behindTunnel(tlsBehind!, async cluster => {
		const names = Array.from({ length: 12 }, (_, i) => `columbus:ssh:tls:${i}`);
		for (const name of names) {
			await cluster.batch(0, [['SET', name, name]]);
		}
		assert.equal((await cluster.scan(0, 'columbus:ssh:tls:*', 100)).keys.length, 12);
		for (const name of names) {
			await cluster.batch(0, [['DEL', name]]);
		}
	});
	const impostor = tlsBehind!.replace(/\/\/[^:/]+/, '//redis-impostor');
	await behindTunnel(impostor, async cluster => {
		await assert.rejects(cluster.version(), /redis-impostor.+altnames|altnames.+redis-impostor/);
	});
});

const tlsSentinelBehind = process.env.COLUMBUS_SSH_REDIS_TLS_SENTINEL_URL;

test('a TLS Sentinel behind SSH checks the Sentinel and the master by their own names', { skip: !tlsSentinelBehind && 'set COLUMBUS_SSH_REDIS_TLS_SENTINEL_URL and COLUMBUS_TOPOLOGY_CA' }, async () => {
	await behindTunnel(tlsSentinelBehind!, async watched => {
		await watched.batch(1, [['SET', 'columbus:ssh:tls:sentinel', 'ok']]);
		assert.deepEqual((await watched.scan(1, 'columbus:ssh:tls:*', 10)).keys.map(k => k.name), ['columbus:ssh:tls:sentinel']);
		await watched.batch(1, [['DEL', 'columbus:ssh:tls:sentinel']]);
	});
	await behindTunnel(tlsSentinelBehind!.replace(/\/\/[^:/]+/, '//redis-impostor'), async watched => {
		await assert.rejects(watched.version(), /redis-impostor.+altnames|altnames.+redis-impostor/);
	});
});

const growBehind = process.env.COLUMBUS_SSH_REDIS_GROW_URL;

test('a node added to a cluster behind SSH is reached once a slot moves to it', { skip: !growBehind && 'set COLUMBUS_SSH_REDIS_GROW_URL to a cluster with a spare node on the next port' }, async () => {
	const seed = parseUrl('redis', growBehind!).port;
	await behindTunnel(growBehind!, async cluster => {
		await cluster.batch(0, [['SET', 'columbus:ssh:grow', 'here']]);
		const owner = await reshard(seed, seed + 3, 'columbus:ssh:grow');
		assert.deepEqual(await cluster.value(0, 'columbus:ssh:grow', 1), { type: 'string', value: 'here', binary: false, ttl: -1 });
		await cluster.batch(0, [['SET', 'columbus:ssh:grow', 'moved']]);
		assert.deepEqual(await read(owner, 'columbus:ssh:grow'), { role: 'master', value: 'moved' });
		assert.deepEqual((await cluster.scan(0, 'columbus:ssh:grow', 10)).keys.map(key => key.name), ['columbus:ssh:grow']);
		await cluster.batch(0, [['DEL', 'columbus:ssh:grow']]);
	});
});

test('the worker opens forwards for every cluster node', { skip: (!clusterBehind || !existsSync(resolve('out/drivers/redis.js'))) && 'set COLUMBUS_SSH_REDIS_CLUSTER_URL and run npm run build' }, async () => {
	const config: ConnectionConfig = { ...parseUrl('redis', clusterBehind!), ssh: { host: '127.0.0.1', port: sshPort, user: 'tunnel', auth: 'password', password: 'secret', fingerprint: await trusted() } };
	const remote = new RemoteRedis(resolve('out/worker.js'), async () => resolve('out/drivers/redis.js'), async () => config, undefined, {
		tunnel: async () => resolve('out/drivers/ssh.js'),
	});
	try {
		await remote.batch(0, [['SET', 'columbus:worker', 'ok']]);
		assert.deepEqual((await remote.scan(0, 'columbus:worker', 10)).keys.map(k => k.name), ['columbus:worker']);
		await remote.batch(0, [['DEL', 'columbus:worker']]);
	} finally {
		remote.dispose();
	}
});

function keyPair(passphrase?: string): { private: string; public: string } {
	for (;;) {
		const pair = passphrase ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 16 }) : utils.generateKeyPairSync('ed25519');
		if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) {
			return pair;
		}
	}
}

function userKey(name: string, passphrase?: string): string {
	const pair = keyPair(passphrase);
	userKeys.push(utils.parseKey(pair.public) as ParsedKey);
	const path = join(keys, name);
	writeFileSync(path, pair.private);
	chmodSync(path, 0o600);
	return path;
}

async function echoThrough(config: ConnectionConfig): Promise<string> {
	const tunnel = await open(config);
	opened.push(tunnel);
	return new Promise<string>((done, fail) => {
		const socket = connect(tunnel.port, tunnel.host, () => socket.write('pong'));
		socket.once('data', data => {
			socket.destroy();
			done(String(data));
		});
		socket.once('error', fail);
	});
}

test('a key pair with a passphrase opens the tunnel, a wrong passphrase is named', async () => {
	const keyFile = userKey('id_locked', 'open sesame');
	const base = target({ fingerprint: await trusted() });
	assert.equal(await echoThrough({ ...base, ssh: { ...base.ssh!, auth: 'key', keyFile, password: 'open sesame' } }), 'pong');
	await assert.rejects(open({ ...base, ssh: { ...base.ssh!, auth: 'key', keyFile, password: 'wrong' } }), /: wrong passphrase for the key file /);
	await assert.rejects(open({ ...base, ssh: { ...base.ssh!, auth: 'key', keyFile, password: '' } }), /: the key file \S+id_locked is protected by a passphrase$/);
	await assert.rejects(open({ ...base, ssh: { ...base.ssh!, auth: 'key', keyFile: join(keys, 'missing') } }), /: cannot read the key file \S+missing \(not found\)$/);
	const stranger = userKey('id_stranger');
	userKeys.pop();
	await assert.rejects(open({ ...base, ssh: { ...base.ssh!, auth: 'key', keyFile: stranger, password: '' } }), /All configured authentication methods failed/);
});

test('the SSH agent signs in with the keys it holds', { skip: process.platform === 'win32' && 'uses OpenSSH ssh-agent' }, async () => {
	const keyFile = userKey('id_agent');
	const socket = join(keys, 'agent.sock');
	const output = execFileSync('ssh-agent', ['-a', socket], { encoding: 'utf8' });
	const pid = /SSH_AGENT_PID=(\d+)/.exec(output)?.[1];
	const previous = process.env.SSH_AUTH_SOCK;
	try {
		execFileSync('ssh-add', [keyFile], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
		const base = target({ fingerprint: await trusted() });
		delete process.env.SSH_AUTH_SOCK;
		await assert.rejects(open({ ...base, ssh: { ...base.ssh!, auth: 'agent', password: '' } }), /: no SSH agent is running \(SSH_AUTH_SOCK is not set\)$/);
		process.env.SSH_AUTH_SOCK = socket;
		assert.equal(await echoThrough({ ...base, ssh: { ...base.ssh!, auth: 'agent', password: '' } }), 'pong');
	} finally {
		if (previous === undefined) {
			delete process.env.SSH_AUTH_SOCK;
		} else {
			process.env.SSH_AUTH_SOCK = previous;
		}
		if (pid) {
			process.kill(Number(pid));
		}
	}
});
