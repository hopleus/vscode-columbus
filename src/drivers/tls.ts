import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import type { ConnectionOptions } from 'node:tls';
import type { ConnectionConfig } from './connection';

const FILES = [['sslCa', 'ca', 'CA file'], ['sslCert', 'cert', 'client certificate'], ['sslKey', 'key', 'client key']] as const;

function resolvePath(path: string): string {
	return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function read(resolved: string, what: string): Buffer {
	try {
		return readFileSync(resolved);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		throw new Error(`SSL: cannot read the ${what} ${resolved} (${code === 'ENOENT' ? 'not found' : code ?? (err as Error).message})`);
	}
}

export interface SecureOptions {
	rejectUnauthorized: boolean;
	ca?: Buffer;
	cert?: Buffer;
	key?: Buffer;
	passphrase?: string;
}

export function secureOptions(config: ConnectionConfig): SecureOptions | undefined {
	if (config.ssl === 'disable') {
		return undefined;
	}
	const options: SecureOptions = { rejectUnauthorized: config.ssl !== 'require' };
	for (const [field, option, what] of FILES) {
		const path = config[field]?.trim();
		if (path) {
			options[option] = read(resolvePath(path), what);
		}
	}
	if (options.key) {
		const path = resolvePath(config.sslKey!.trim());
		try {
			createPrivateKey({ key: options.key, passphrase: config.sslPassphrase ?? '' });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ERR_OSSL_BAD_DECRYPT') {
				throw new Error(config.sslPassphrase ? `SSL: wrong passphrase for the client key ${path}` : `SSL: the client key ${path} is protected by a passphrase`);
			}
			throw new Error(`SSL: ${path} is not a supported private key (${(err as Error).message})`);
		}
		if (config.sslPassphrase) {
			options.passphrase = config.sslPassphrase;
		}
	}
	return options;
}

export function identityOptions(config: ConnectionConfig, host: string, fallback?: string): ConnectionOptions {
	const servername = isIP(host) ? undefined : host;
	if (config.ssl !== 'verify-full') {
		return { ...(servername ? { servername } : {}), checkServerIdentity: () => undefined };
	}
	if (servername) {
		return { servername, checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert) };
	}
	return {
		checkServerIdentity: (_name, cert) => {
			const mismatch = checkServerIdentity(host, cert);
			return mismatch && fallback && !isIP(fallback) ? checkServerIdentity(fallback, cert) : mismatch;
		},
	};
}
