import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { SourceStore, isSourceId } from '../store';

function store(value: unknown): SourceStore {
	const state = { get: (_key: string, fallback?: unknown) => value ?? fallback, update: async () => undefined, keys: () => [] };
	return new SourceStore(state as unknown as vscode.Memento, {} as vscode.SecretStorage);
}

test('source ids are safe path segments', () => {
	for (const id of ['3f2b6c1e-8d2a-4c5e-9b1f-0a7d6e5c4b3a', 'demo', 'a_b-1']) {
		assert.equal(isSourceId(id), true, id);
	}
	for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', ' a', 'é', undefined, null, 1]) {
		assert.equal(isSourceId(id), false, String(id));
	}
});

test('data sources with unsafe ids or a broken list are not loaded', () => {
	const source = (id: unknown): Record<string, unknown> => ({ id, name: String(id), driver: 'redis', host: 'h', port: 1, database: '0', user: '', ssl: 'disable' });
	assert.deepEqual(store([source('ok'), source('../escape'), source('a/b'), null, source(7)]).list().map(s => s.id), ['ok']);
	assert.deepEqual(store({ id: 'ok' }).list(), []);
	assert.deepEqual(store(undefined).list(), []);
});

test('a data source moves between stores without touching its passwords', async () => {
	const memory = (): vscode.Memento => {
		const data = new Map<string, unknown>();
		return { get: (key: string, fallback?: unknown) => data.get(key) ?? fallback, update: async (key: string, value: unknown) => void data.set(key, value), keys: () => [...data.keys()] } as vscode.Memento;
	};
	const secrets = new Map<string, string>();
	const vault = { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => void secrets.set(key, value), delete: async (key: string) => void secrets.delete(key) } as unknown as vscode.SecretStorage;
	const project = new SourceStore(memory(), vault);
	const global = new SourceStore(memory(), vault);
	const source = { id: 'a', name: 'a', driver: 'postgres' as const, host: 'h', port: 5432, database: 'db', user: 'u', ssl: 'disable' as const };
	await project.add(source, { password: 'pw' });
	await global.put(source);
	await global.put({ ...source, name: 'renamed' });
	await project.detach('a');
	assert.deepEqual(project.list(), []);
	assert.deepEqual(global.list().map(s => s.name), ['renamed']);
	assert.equal(await global.password('a'), 'pw');
	await global.remove('a');
	assert.equal(await project.password('a'), undefined);
});
