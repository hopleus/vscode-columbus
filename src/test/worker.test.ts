import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseUrl } from '../drivers/connection';
import type { ConnectionConfig } from '../drivers/connection';
import { RemoteDriver } from '../drivers/remote';

const skip = existsSync(resolve('out/worker.js')) ? false : 'run npm run build first';

const TUNNEL = `exports.open = async () => {
	const listeners = [];
	globalThis.closeTunnel = reason => listeners.forEach(listener => listener(reason));
	return { host: '127.0.0.1', port: 1, forward: async () => ({ host: '127.0.0.1', port: 1 }), failure: () => undefined, onClose: listener => listeners.push(listener) };
};
`;

const RESET = `() => {
	const err = new Error('read ECONNRESET');
	err.code = 'ECONNRESET';
	throw err;
}`;

const DRIVERS = {
	reset: `exports.create = () => ({
	version: () => new Promise(() => {
		setImmediate(${RESET});
		setTimeout(() => globalThis.closeTunnel?.('SSH connection to bastion:22 was closed'), 50);
	}),
});
`,
	closed: `exports.create = () => ({
	version: () => new Promise(() => {
		globalThis.closeTunnel?.('SSH connection to bastion:22 was closed');
		process.nextTick(${RESET});
	}),
});
`,
};

async function crash(ssh: boolean, order: keyof typeof DRIVERS = 'reset'): Promise<unknown> {
	const dir = mkdtempSync(join(tmpdir(), 'columbus-worker-'));
	writeFileSync(join(dir, 'tunnel.cjs'), TUNNEL);
	writeFileSync(join(dir, 'driver.cjs'), DRIVERS[order]);
	const config: ConnectionConfig = {
		...parseUrl('postgres', 'postgresql://user@127.0.0.1:5432/db'),
		...(ssh ? { ssh: { host: 'bastion', port: 22, user: 'tunnel', auth: 'password' as const, password: '' } } : {}),
	};
	const remote = new RemoteDriver('postgres', resolve('out/worker.js'), async () => join(dir, 'driver.cjs'), async () => config, undefined, { tunnel: async () => join(dir, 'tunnel.cjs') });
	const alive = setInterval(() => undefined, 1000);
	try {
		return await remote.version().then(() => undefined, (err: unknown) => err);
	} finally {
		clearInterval(alive);
		remote.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a worker that loses its connection while the SSH tunnel closes reports the closed tunnel', { skip }, async () => {
	assert.match(String(await crash(true)), /^Error: SSH connection to bastion:22 was closed$/);
});

test('a connection lost after the SSH tunnel closed is reported as the closed tunnel', { skip }, async () => {
	const started = Date.now();
	assert.match(String(await crash(true, 'closed')), /^Error: SSH connection to bastion:22 was closed$/);
	assert.ok(Date.now() - started < 400);
});

test('a worker without a tunnel reports a lost connection as it is', { skip }, async () => {
	assert.match(String(await crash(false)), /read ECONNRESET/);
});
