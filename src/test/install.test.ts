import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cached, download, entryOf, forget, previous, sha256, store } from '../drivers/install';

const body = 'module.exports = { create() {} };';
const url = `data:text/javascript;base64,${Buffer.from(body).toString('base64')}`;
const entry = { file: 'columbus-driver-mysql.js', sha256: sha256(Buffer.from(body)), size: body.length };

function folder(): string {
	return mkdtempSync(join(tmpdir(), 'columbus-drivers-'));
}

test('download verifies, stores and finds a driver file', async () => {
	const dir = folder();
	try {
		assert.equal(await cached(dir, 'mysql', entry), undefined);
		const path = await download(url, dir, 'mysql', entry);
		assert.equal(readFileSync(path, 'utf8'), body);
		assert.equal(await cached(dir, 'mysql', entry), path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download rejects a file with a wrong checksum', async () => {
	const dir = folder();
	try {
		await assert.rejects(download(url, dir, 'mysql', { ...entry, sha256: '0'.repeat(64) }), /checksum/);
		assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download replaces older files of the same driver only', async () => {
	const dir = folder();
	try {
		writeFileSync(join(dir, 'mysql-0000000000000000.js'), 'old');
		writeFileSync(join(dir, 'postgres-0000000000000000.js'), 'other');
		const path = await download(url, dir, 'mysql', entry);
		assert.deepEqual(readdirSync(dir).sort(), [path.slice(dir.length + 1), 'mysql.json', 'postgres-0000000000000000.js'].sort());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a tampered cached file is not used', async () => {
	const dir = folder();
	try {
		const path = await download(url, dir, 'mysql', entry);
		writeFileSync(path, 'tampered');
		assert.equal(await cached(dir, 'mysql', entry), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('download reports HTTP errors', async () => {
	const fetcher = (async () => new Response('missing', { status: 404, statusText: 'Not Found' })) as typeof fetch;
	await assert.rejects(download('https://example.invalid/x.js', folder(), 'mysql', entry, fetcher), /404 Not Found/);
});

test('stored files remember their version, and an older one is found after an update', async () => {
	const dir = folder();
	try {
		const old = new TextEncoder().encode('old driver');
		const fresh = new TextEncoder().encode('new driver');
		await store(dir, 'postgres', { file: 'columbus-driver-postgres.js', sha256: sha256(old), size: old.length, library: 'pg', version: '8.1.0' }, old);
		const entry = { file: 'columbus-driver-postgres.js', sha256: sha256(fresh), size: fresh.length, library: 'pg', version: '8.2.0' };
		assert.equal(await cached(dir, 'postgres', entry), undefined);
		assert.deepEqual(await previous(dir, 'postgres'), { sha256: sha256(old), library: 'pg', version: '8.1.0' });
		await assert.rejects(store(dir, 'postgres', entry, old), /checksum/);
		await store(dir, 'postgres', entry, fresh);
		assert.equal((await previous(dir, 'postgres'))?.version, '8.2.0');
		assert.deepEqual(entryOf({ postgres: entry, mysql: { ...entry, sha256: 'x' } }, fresh), ['postgres', entry]);
		assert.equal(entryOf({ postgres: entry }, old), undefined);
		await forget(dir, 'postgres');
		assert.equal(await previous(dir, 'postgres'), undefined);
		assert.equal(await cached(dir, 'postgres', entry), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
