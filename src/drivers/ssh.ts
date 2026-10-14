import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, utils } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { ConnectionConfig, SshConfig } from './connection';

export interface Address {
	host: string;
	port: number;
}

export interface Tunnel extends Address {
	forward(host: string, port: number): Promise<Address>;
	failure(): string | undefined;
	onClose(listener: (reason: string) => void): void;
	close(): void;
}

const FAILURE_TTL = 10_000;

export function fingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function keyPath(path: string): string {
	return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

async function privateKey(path: string, passphrase: string | undefined): Promise<Partial<ConnectConfig>> {
	const key = await readFile(path).catch((err: NodeJS.ErrnoException) => {
		throw new Error(`cannot read the key file ${path} (${err.code === 'ENOENT' ? 'not found' : err.code ?? err.message})`);
	});
	const parsed = utils.parseKey(key, passphrase || undefined);
	if (parsed instanceof Error) {
		if (!/passphrase/i.test(parsed.message)) {
			throw new Error(`${path} is not a supported private key (${parsed.message})`);
		}
		throw new Error(passphrase ? `wrong passphrase for the key file ${path}` : `the key file ${path} is protected by a passphrase`);
	}
	return { privateKey: key, ...(passphrase ? { passphrase } : {}) };
}

async function credentials(ssh: SshConfig): Promise<Partial<ConnectConfig>> {
	switch (ssh.auth) {
		case 'password':
			return { password: ssh.password ?? '' };
		case 'key':
			if (!ssh.keyFile) {
				throw new Error('choose a private key file');
			}
			return privateKey(keyPath(ssh.keyFile), ssh.password);
		case 'agent': {
			const agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK;
			if (!agent) {
				throw new Error('no SSH agent is running (SSH_AUTH_SOCK is not set)');
			}
			return { agent };
		}
	}
}

export async function open(config: ConnectionConfig): Promise<Tunnel> {
	const ssh = config.ssh;
	if (!ssh) {
		throw new Error('SSH: the data source has no SSH tunnel');
	}
	const client = new Client();
	let offered: string | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			client.once('ready', resolve);
			client.once('error', reject);
			void credentials(ssh).then(auth => client.connect({
				host: ssh.host,
				port: ssh.port,
				username: ssh.user,
				readyTimeout: 15_000,
				keepaliveInterval: 30_000,
				hostVerifier: (key: Buffer) => {
					offered = fingerprint(key);
					return offered === ssh.fingerprint;
				},
				...auth,
			}), reject);
		});
	} catch (err) {
		client.end();
		if (offered && offered !== ssh.fingerprint) {
			const what = ssh.fingerprint ? `SSH host key of ${ssh.host}:${ssh.port} changed` : `SSH host ${ssh.host}:${ssh.port} is not trusted yet`;
			throw new Error(`${what} (key ${offered})`);
		}
		throw new Error(`SSH ${ssh.host}:${ssh.port}: ${(err as Error).message}`);
	}
	const servers: Server[] = [];
	const forwards = new Map<string, Promise<Address>>();
	let failure: { message: string; at: number } | undefined;
	const listen = async (host: string, port: number): Promise<Address> => {
		const server: Server = createServer(socket => {
			client.forwardOut('127.0.0.1', socket.remotePort ?? 0, host, port, (err, stream) => {
				if (err) {
					failure = { message: `SSH ${ssh.host}:${ssh.port} cannot reach ${host}:${port}: ${err.message.replace(/^\(SSH\) /, '').replace(/:\s*$/, '')}`, at: Date.now() };
					socket.destroy();
					return;
				}
				failure = undefined;
				socket.pipe(stream).pipe(socket);
				stream.on('error', () => socket.destroy());
				socket.on('error', () => stream.destroy());
				stream.on('close', () => socket.destroy());
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		servers.push(server);
		return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
	};
	const forward = (host: string, port: number): Promise<Address> => {
		const key = `${host}:${port}`;
		let found = forwards.get(key);
		if (!found) {
			found = listen(host, port);
			found.catch(() => forwards.delete(key));
			forwards.set(key, found);
		}
		return found;
	};
	const close = (): void => {
		for (const server of servers) {
			server.close();
		}
	};
	const listeners: ((reason: string) => void)[] = [];
	let closing = false;
	let lost: Error | undefined;
	client.on('error', err => {
		lost = err;
	});
	client.on('close', () => {
		close();
		if (!closing) {
			const reason = `SSH connection to ${ssh.host}:${ssh.port} was closed${lost ? `: ${lost.message}` : ''}`;
			for (const listener of listeners) {
				listener(reason);
			}
		}
	});
	const primary = await forward(config.host, config.port);
	return {
		...primary,
		forward,
		failure: () => {
			const recent = failure && Date.now() - failure.at < FAILURE_TTL ? failure.message : undefined;
			failure = undefined;
			return recent;
		},
		onClose: listener => listeners.push(listener),
		close: () => {
			closing = true;
			close();
			client.end();
		},
	};
}
