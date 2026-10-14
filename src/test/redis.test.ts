import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { parseUrl } from '../drivers/connection';
import { RedisDriver } from '../drivers/redis';
import { RemoteRedis } from '../drivers/remote';
import { collection, commandsFor, hexColumns } from '../redis/values';
import { clusterTransactions, failover, read } from './topology';

const url = process.env.COLUMBUS_REDIS_URL;
const skip = !url && 'set COLUMBUS_REDIS_URL to run against Redis or Valkey';
const config = url ? parseUrl('redis', url) : undefined;
const DB = 13;

let driver: RedisDriver | undefined;
const redis = (): RedisDriver => (driver ??= new RedisDriver(config!));

test.after(() => driver?.dispose());

test('redis URLs carry the database index and TLS', () => {
	assert.deepEqual(parseUrl('redis', 'rediss://app:secret@cache.local/3'), {
		driver: 'redis', host: 'cache.local', port: 6379, database: '3', user: 'app', password: 'secret', ssl: 'require',
	});
	assert.equal(parseUrl('redis', 'valkey://localhost').database, '0');
});

test('version names Redis or Valkey', { skip }, async () => {
	assert.match(await redis().version(), /^(Redis|Valkey|Dragonfly) \d+\.\d+/);
});

test('keys come with type and TTL, databases with key counts', { skip }, async () => {
	await redis().command(DB, ['FLUSHDB']);
	await redis().batch(DB, [
		['SET', 'user:1:name', 'Ann'],
		['SET', 'session:9', 'x', 'PX', '600000'],
		['HSET', 'user:1', 'email', 'ann@example.com', 'name', 'Ann'],
		['RPUSH', 'queue', 'a', 'b', 'c'],
		['SADD', 'tags', 'red', 'blue'],
		['ZADD', 'scores', '2', 'bob', '1', 'ann'],
		['XADD', 'events', '1-1', 'kind', 'login'],
	]);
	const { keys, complete } = await redis().scan(DB, '*', 100);
	assert.ok(complete);
	assert.deepEqual(keys.map(k => `${k.name}:${k.type}`), [
		'events:stream', 'queue:list', 'scores:zset', 'session:9:string', 'tags:set', 'user:1:hash', 'user:1:name:string',
	]);
	assert.ok(keys.find(k => k.name === 'session:9')!.ttl > 590000);
	assert.equal(keys.find(k => k.name === 'queue')!.ttl, -1);
	assert.deepEqual((await redis().scan(DB, 'user:*', 100)).keys.map(k => k.name), ['user:1', 'user:1:name']);
	assert.equal((await redis().databases()).find(d => d.index === DB)?.keys, 7);
});

test('values are read by type', { skip }, async () => {
	assert.deepEqual(await redis().value(DB, 'user:1:name', 100), { type: 'string', value: 'Ann', binary: false, ttl: -1 });
	assert.deepEqual(await redis().value(DB, 'user:1', 100), { type: 'hash', entries: [['email', 'ann@example.com'], ['name', 'Ann']], hex: [], total: 2, ttl: -1 });
	assert.deepEqual(await redis().value(DB, 'queue', 2), { type: 'list', items: ['a', 'b'], hex: [], total: 3, ttl: -1 });
	assert.deepEqual(await redis().value(DB, 'tags', 100), { type: 'set', members: ['blue', 'red'], hex: [], total: 2, ttl: -1 });
	assert.deepEqual(await redis().value(DB, 'scores', 100), { type: 'zset', entries: [['ann', '1'], ['bob', '2']], hex: [], total: 2, ttl: -1 });
	assert.deepEqual(await redis().value(DB, 'events', 100), { type: 'stream', entries: [['1-1', [['kind', 'login']]]], total: 1, ttl: -1 });
	assert.deepEqual(await redis().value(DB, 'missing', 100), { type: 'none' });
});

test('binary strings are shown as hex and saved as bytes', { skip }, async () => {
	await redis().batch(DB, [['SET', 'blob', Uint8Array.from([0, 255, 200])]]);
	assert.deepEqual(await redis().value(DB, 'blob', 1), { type: 'string', value: '0x00ffc8', binary: true, ttl: -1 });
	await redis().batch(DB, [['DEL', 'blob']]);
});

test('binary fields, values, members and key names keep their bytes through the grid', { skip }, async () => {
	const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
	const name = bytes(0x62, 0x69, 0x6e, 0xff);
	await redis().batch(DB, [
		['HSET', 'bin:hash', bytes(0xff, 0x01), bytes(0xc3, 0x28), 'text', 'ok'],
		['RPUSH', 'bin:list', bytes(0xfe), 'plain'],
		['SADD', 'bin:set', bytes(0x80)],
		['ZADD', 'bin:zset', '2', bytes(0xc0, 0xaf)],
		['SET', name, 'binary name'],
	]);
	try {
		const hash = await redis().value(DB, 'bin:hash', 10);
		assert.deepEqual(hash, { type: 'hash', entries: [['0xff01', '0xc328'], ['0x74657874', '0x6f6b']], hex: ['field', 'value'], total: 2, ttl: -1 });
		const grid = collection(hash)!;
		assert.deepEqual(grid.columns.map(c => c.type), ['binary', 'binary']);
		await redis().batch(DB, commandsFor('hash', 'bin:hash', [
			{ kind: 'update', key: { field: '0xff01' }, values: { value: '0x00ff' } },
			{ kind: 'insert', values: { field: '0xfe', value: 'new' } },
		], grid.rows, hexColumns(grid.columns)));
		const raw = await redis().command(DB, ['HGET', 'bin:hash', bytes(0xff, 0x01)]);
		assert.equal(raw, '0x00ff');
		assert.equal(await redis().command(DB, ['HGET', 'bin:hash', bytes(0xfe)]), 'new');
		assert.equal(await redis().command(DB, ['HGET', 'bin:hash', 'text']), 'ok');
		assert.deepEqual(await redis().value(DB, 'bin:list', 10), { type: 'list', items: ['0xfe', '0x706c61696e'], hex: ['value'], total: 2, ttl: -1 });
		assert.deepEqual(await redis().value(DB, 'bin:set', 10), { type: 'set', members: ['0x80'], hex: ['member'], total: 1, ttl: -1 });
		const zset = await redis().value(DB, 'bin:zset', 10);
		assert.deepEqual(zset, { type: 'zset', entries: [['0xc0af', '2']], hex: ['member'], total: 1, ttl: -1 });
		await redis().batch(DB, commandsFor('zset', 'bin:zset', [{ kind: 'update', key: { member: '0xc0af' }, values: { score: 5 } }], collection(zset)!.rows, hexColumns(collection(zset)!.columns)));
		assert.equal(await redis().command(DB, ['ZSCORE', 'bin:zset', bytes(0xc0, 0xaf)]), '5');
		const key = (await redis().scan(DB, 'bin*', 10)).keys.find(k => k.bytes);
		assert.deepEqual(key && { ...key, bytes: [...key.bytes!] }, { name: '0x62696eff', bytes: [...name], type: 'string', ttl: -1 });
		assert.deepEqual(await redis().value(DB, key!.bytes!, 1), { type: 'string', value: 'binary name', binary: false, ttl: -1 });
		await redis().setString(DB, key!.bytes!, 'renamed value');
		assert.equal(await redis().command(DB, ['GET', name]), 'renamed value');
	} finally {
		await redis().batch(DB, [['DEL', 'bin:hash', 'bin:list', 'bin:set', 'bin:zset', name]]);
	}
});

test('strings keep their TTL when saved', { skip }, async () => {
	await redis().setString(DB, 'session:9', '{"a":1}');
	const value = await redis().value(DB, 'session:9', 1);
	assert.ok(value.type === 'string' && value.value === '{"a":1}' && value.ttl > 0);
});

test('console sessions keep their own database and return plain replies', { skip }, async () => {
	assert.deepEqual(await redis().execute('console', 0, ['SELECT', String(DB)]), { reply: 'OK', db: DB });
	assert.deepEqual(await redis().execute('console', 0, ['LRANGE', 'queue', '0', '-1']), { reply: ['a', 'b', 'c'], db: DB });
	assert.deepEqual(await redis().execute('console', 0, ['HGETALL', 'nothing']), { reply: [], db: DB });
	assert.deepEqual(await redis().execute('console', 0, ['GET', 'nothing']), { reply: null, db: DB });
	assert.deepEqual(await redis().execute('console', 0, ['EXISTS', 'queue']), { reply: 1, db: DB });
	await assert.rejects(redis().execute('console', 0, ['NOPE']), /unknown command/i);
	await redis().release('console');
});

test('command docs describe commands and their arguments', { skip }, async () => {
	const docs = await redis().commands();
	const set = docs.find(d => d.name === 'SET');
	assert.ok(set);
	assert.ok(!set.summary || set.arguments.some(a => a.name === 'key' && a.type === 'key'));
});

test('the worker runs the bundled Redis driver', { skip: skip || (!existsSync(resolve('out/drivers/redis.js')) && 'run npm run build first') }, async () => {
	let connected = false;
	const remote = new RemoteRedis(resolve('out/worker.js'), async () => join(resolve('out'), 'drivers', 'redis.js'), async () => config!, value => {
		connected = value;
	});
	try {
		assert.match(await remote.version(), /^(Redis|Valkey|Dragonfly) /);
		assert.ok(connected);
		assert.deepEqual(await remote.batch(DB, [['DEL', 'tmp'], ['SET', 'tmp', '1'], ['INCR', 'tmp']]), [0, 'OK', 2]);
	} finally {
		remote.dispose();
	}
	assert.equal(connected, false);
});

const clusterUrl = process.env.COLUMBUS_REDIS_CLUSTER_URL;
const sentinelUrl = process.env.COLUMBUS_REDIS_SENTINEL_URL;

test('cluster and sentinel URLs carry their mode', () => {
	assert.deepEqual(parseUrl('redis', 'redis+cluster://cache:7000'), { driver: 'redis', host: 'cache', port: 7000, database: '0', user: '', password: '', ssl: 'disable', mode: 'cluster' });
	const sentinel = parseUrl('redis', 'redis+sentinel://watch/mymaster/2');
	assert.deepEqual([sentinel.port, sentinel.master, sentinel.database, sentinel.mode], [26379, 'mymaster', '2', 'sentinel']);
	assert.throws(() => parseUrl('redis', 'redis+sentinel://watch'), /master name/);
});

test('a fresh cluster connection lists its database before any other command', { skip: !clusterUrl && 'set COLUMBUS_REDIS_CLUSTER_URL' }, async () => {
	const fresh = new RedisDriver(parseUrl('redis', clusterUrl!));
	try {
		assert.deepEqual((await fresh.databases()).map(d => d.index), [0]);
	} finally {
		fresh.dispose();
	}
	const scanning = new RedisDriver(parseUrl('redis', clusterUrl!));
	try {
		assert.equal((await scanning.scan(0, '*', 10)).complete !== undefined, true);
	} finally {
		scanning.dispose();
	}
});

test('a cluster scans every master and routes keys by slot', { skip: !clusterUrl && 'set COLUMBUS_REDIS_CLUSTER_URL' }, async () => {
	const cluster = new RedisDriver(parseUrl('redis', clusterUrl!));
	try {
		const names = Array.from({ length: 30 }, (_, i) => `columbus:cluster:${i}`);
		for (const name of names) {
			await cluster.batch(0, [['SET', name, name]]);
		}
		await cluster.batch(0, [['HSET', 'columbus:cluster:hash', 'a', '1']]);
		const { keys, complete } = await cluster.scan(0, 'columbus:cluster:*', 1000);
		assert.equal(complete, true);
		assert.equal(keys.length, 31);
		assert.equal(keys.find(k => k.name === 'columbus:cluster:hash')?.type, 'hash');
		assert.ok((await cluster.databases())[0].keys >= 31);
		assert.deepEqual(await cluster.value(0, 'columbus:cluster:7', 10), { type: 'string', value: 'columbus:cluster:7', binary: false, ttl: -1 });
		assert.deepEqual((await cluster.execute('console', 0, ['GET', 'columbus:cluster:12'])).reply, 'columbus:cluster:12');
		for (const name of [...names, 'columbus:cluster:hash']) {
			await cluster.batch(0, [['DEL', name]]);
		}
	} finally {
		cluster.dispose();
	}
});

test('the console runs MULTI and WATCH on a cluster on the node of the key', { skip: !clusterUrl && 'set COLUMBUS_REDIS_CLUSTER_URL' }, async () => {
	const cluster = new RedisDriver(parseUrl('redis', clusterUrl!));
	const other = new RedisDriver(parseUrl('redis', clusterUrl!));
	try {
		await clusterTransactions(cluster, other);
	} finally {
		cluster.dispose();
		other.dispose();
	}
});

test('sentinel finds the master and keeps databases', { skip: !sentinelUrl && 'set COLUMBUS_REDIS_SENTINEL_URL' }, async () => {
	const watched = new RedisDriver(parseUrl('redis', sentinelUrl!));
	try {
		assert.match(await watched.version(), /^Redis \d/);
		await watched.batch(3, [['SET', 'columbus:sentinel', 'ok']]);
		assert.deepEqual((await watched.scan(3, 'columbus:*', 10)).keys.map(k => k.name), ['columbus:sentinel']);
		assert.ok((await watched.databases()).find(d => d.index === 3)!.keys >= 1);
		await watched.batch(3, [['DEL', 'columbus:sentinel']]);
	} finally {
		watched.dispose();
	}
});

test('an unreachable source reports the network error in every mode', async () => {
	for (const unreachable of ['redis://127.0.0.1:1/0', 'redis+sentinel://127.0.0.1:1/mymaster/0', 'redis+cluster://127.0.0.1:1']) {
		const down = new RedisDriver(parseUrl('redis', unreachable));
		try {
			await assert.rejects(down.version(), { message: 'connect ECONNREFUSED 127.0.0.1:1' }, unreachable);
		} finally {
			down.dispose();
		}
	}
});

test('a standalone server is not taken for a Sentinel or a cluster', { skip }, async () => {
	for (const [mode, message] of [['sentinel', /^127\.0\.0\.1:\d+ is not a Sentinel$/], ['cluster', /^127\.0\.0\.1:\d+ is not a cluster node$/]] as const) {
		const wrong = new RedisDriver({ ...config!, mode, master: 'mymaster' });
		try {
			await assert.rejects(wrong.version(), { message });
		} finally {
			wrong.dispose();
		}
	}
});

const tlsClusterUrl = process.env.COLUMBUS_REDIS_TLS_CLUSTER_URL;

test('a TLS cluster is verified on every node', { skip: !tlsClusterUrl && 'set COLUMBUS_REDIS_TLS_CLUSTER_URL and COLUMBUS_TOPOLOGY_CA' }, async () => {
	const secure = new RedisDriver({ ...parseUrl('redis', tlsClusterUrl!), sslCa: process.env.COLUMBUS_TOPOLOGY_CA });
	try {
		const names = Array.from({ length: 12 }, (_, i) => `columbus:tls:${i}`);
		for (const name of names) {
			await secure.batch(0, [['SET', name, name]]);
		}
		assert.equal((await secure.scan(0, 'columbus:tls:*', 100)).keys.length, 12);
		for (const name of names) {
			await secure.batch(0, [['DEL', name]]);
		}
	} finally {
		secure.dispose();
	}
});

const tlsSentinelUrl = process.env.COLUMBUS_REDIS_TLS_SENTINEL_URL;

test('a TLS Sentinel and its master are both reached over TLS', { skip: !tlsSentinelUrl && 'set COLUMBUS_REDIS_TLS_SENTINEL_URL and COLUMBUS_TOPOLOGY_CA' }, async () => {
	const secure = new RedisDriver({ ...parseUrl('redis', tlsSentinelUrl!), sslCa: process.env.COLUMBUS_TOPOLOGY_CA });
	try {
		await secure.batch(1, [['SET', 'columbus:tls:sentinel', 'ok']]);
		assert.deepEqual((await secure.scan(1, 'columbus:tls:*', 10)).keys.map(k => k.name), ['columbus:tls:sentinel']);
		await secure.batch(1, [['DEL', 'columbus:tls:sentinel']]);
	} finally {
		secure.dispose();
	}
});

const failoverUrl = process.env.COLUMBUS_REDIS_FAILOVER_URL;

test('writes follow a Sentinel failover to the promoted master', { skip: !failoverUrl && 'set COLUMBUS_REDIS_FAILOVER_URL to a Sentinel with a replica' }, async () => {
	const config = parseUrl('redis', failoverUrl!);
	const watched = new RedisDriver(config);
	try {
		await watched.batch(0, [['SET', 'columbus:failover', 'before']]);
		const promoted = await failover(config.port, config.master!);
		await watched.batch(0, [['SET', 'columbus:failover', 'after']]);
		assert.deepEqual(await read(promoted, 'columbus:failover'), { role: 'master', value: 'after' });
		assert.deepEqual(await watched.value(0, 'columbus:failover', 1), { type: 'string', value: 'after', binary: false, ttl: -1 });
		await watched.batch(0, [['DEL', 'columbus:failover']]);
	} finally {
		watched.dispose();
	}
});

test('a connection lost for longer than the retries opens again on the next request', { skip }, async () => {
	const sockets = new Set<Socket>();
	const proxy = (port: number): Promise<Server> => new Promise(done => {
		const server = createServer(client => {
			const upstream = connect(config!.port, config!.host);
			for (const socket of [client, upstream]) {
				sockets.add(socket);
				socket.on('error', () => undefined);
				socket.on('close', () => {
					client.destroy();
					upstream.destroy();
				});
			}
			client.pipe(upstream).pipe(client);
		});
		server.listen(port, '127.0.0.1', () => done(server));
	});
	let server = await proxy(0);
	const port = (server.address() as AddressInfo).port;
	const flaky = new RedisDriver({ ...config!, host: '127.0.0.1', port });
	try {
		assert.equal((await flaky.execute('console', 2, ['PING'])).reply, 'PONG');
		await flaky.execute('console', 2, ['SELECT', '4']);
		assert.match(await flaky.version(), /\d/);
		server.close();
		for (const socket of sockets) {
			socket.destroy();
		}
		await new Promise(done => setTimeout(done, 2000));
		await assert.rejects(flaky.version(), /^Error: connect ECONNREFUSED 127\.0\.0\.1:\d+$/);
		server = await proxy(port);
		assert.match(await flaky.version(), /\d/);
		assert.deepEqual(await flaky.execute('console', 2, ['PING']), { reply: 'PONG', db: 4 });
	} finally {
		flaky.dispose();
		server.close();
	}
});
