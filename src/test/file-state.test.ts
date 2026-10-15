import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { FileState, importLegacy } from '../file-state';

function temp(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'columbus-project-')), '.columbus');
}

test('project state starts empty and returns defaults', () => {
	const state = new FileState(temp(), true);
	assert.deepEqual(state.keys(), []);
	assert.equal(state.get('missing'), undefined);
	assert.deepEqual(state.get('missing', ['x']), ['x']);
});

test('project state is written to the folder and read back by a new instance', async () => {
	const root = temp();
	const state = new FileState(root, true);
	await state.update('columbus.dataSources', [{ id: 'a', name: 'A' }]);
	await state.update('columbus.keyPatterns', { 'a/0': 'user:*' });
	const again = new FileState(root, true);
	assert.deepEqual(again.get('columbus.dataSources'), [{ id: 'a', name: 'A' }]);
	assert.deepEqual(again.get('columbus.keyPatterns'), { 'a/0': 'user:*' });
	assert.deepEqual([...again.keys()].sort(), ['columbus.dataSources', 'columbus.keyPatterns']);
});

test('the folder ignores itself in git', async () => {
	const root = temp();
	await new FileState(root, true).update('k', 1);
	assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '*\n');
});

test('updating a key with undefined removes it', async () => {
	const root = temp();
	const state = new FileState(root, true);
	await state.update('a', 1);
	await state.update('b', 2);
	await state.update('a', undefined);
	assert.deepEqual(state.keys(), ['b']);
	assert.deepEqual(new FileState(root, true).keys(), ['b']);
});

test('concurrent updates end with the last value on disk', async () => {
	const root = temp();
	const state = new FileState(root, true);
	await Promise.all(Array.from({ length: 20 }, (_, i) => state.update('n', i)));
	assert.equal(new FileState(root, true).get('n'), 19);
});

test('a broken or foreign state file is kept as a backup before the first write', async () => {
	for (const content of ['{not json', '[1,2]', 'null', '"text"']) {
		const root = temp();
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, 'state.json'), content);
		const state = new FileState(root, true);
		assert.deepEqual(state.keys(), [], content);
		await state.update('k', 1);
		await state.update('k', 2);
		assert.equal(new FileState(root, true).get('k'), 2, content);
		assert.equal(fs.readFileSync(path.join(root, 'state.json.bak'), 'utf8'), content);
	}
});

test('writes leave no temporary files behind', async () => {
	const root = temp();
	const state = new FileState(root, true);
	await Promise.all(Array.from({ length: 5 }, (_, i) => state.update(`k${i}`, i)));
	assert.deepEqual(fs.readdirSync(root).sort(), ['.gitignore', 'state.json']);
});

test('a .gitignore changed by the user is kept', async () => {
	const root = temp();
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, '.gitignore'), 'consoles/\n');
	await new FileState(root, true).update('k', 1);
	assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'consoles/\n');
});

test('state is not written through symbolic links', async t => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'columbus-outside-'));
	const linkedRoot = temp();
	fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
	try {
		fs.symlinkSync(outside, linkedRoot, 'dir');
	} catch {
		t.skip('symbolic links are not available');
		return;
	}
	await assert.rejects(Promise.resolve(new FileState(linkedRoot, true).update('k', 1)), /symbolic link/);
	assert.deepEqual(fs.readdirSync(outside), []);

	const root = temp();
	fs.mkdirSync(root, { recursive: true });
	const target = path.join(outside, 'target.json');
	fs.writeFileSync(target, 'original');
	fs.symlinkSync(target, path.join(root, 'state.json'));
	await assert.rejects(Promise.resolve(new FileState(root, true).update('k', 1)), /symbolic link/);
	assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('a change written by another window is read at once', async () => {
	const root = temp();
	const first = new FileState(root);
	const second = new FileState(root);
	await second.update('columbus.dataSources', [{ id: 'b' }]);
	assert.deepEqual(first.get('columbus.dataSources'), [{ id: 'b' }]);
	assert.deepEqual(first.keys(), ['columbus.dataSources']);
});

test('an update keeps what another window wrote meanwhile', async () => {
	const root = temp();
	const first = new FileState(root);
	const second = new FileState(root);
	await first.update('x', 1);
	await second.update('y', 2);
	await first.update('z', 3);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')), { x: 1, y: 2, z: 3 });
});

test('an update that is not written yet survives a change from another window', async () => {
	const root = temp();
	const first = new FileState(root);
	const second = new FileState(root);
	await second.update('y', 1);
	const pending = first.update('x', 1);
	fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ y: 2 }));
	assert.equal(first.get('x'), 1);
	assert.equal(first.get('y'), 2);
	await pending;
	assert.deepEqual(new FileState(root).get('y'), 2);
	assert.deepEqual(new FileState(root).get('x'), 1);
});

test('a file broken from outside keeps the state in memory and is backed up on the next write', async () => {
	const root = temp();
	const state = new FileState(root);
	await state.update('x', 1);
	fs.writeFileSync(path.join(root, 'state.json'), '{oops');
	assert.equal(state.get('x'), 1);
	await state.update('y', 2);
	assert.equal(fs.readFileSync(path.join(root, 'state.json.bak'), 'utf8'), '{oops');
	assert.deepEqual(new FileState(root).keys().slice().sort(), ['x', 'y']);
});

test('the global state folder gets no .gitignore', async () => {
	const root = temp();
	await new FileState(root).update('k', 1);
	assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

function memento(values: Record<string, unknown>): vscode.Memento {
	return { keys: () => Object.keys(values), get: (key: string) => values[key], update: async () => undefined } as unknown as vscode.Memento;
}

test('data of Columbus 0.1.0 is imported once from globalState', async () => {
	const root = temp();
	const legacy = memento({ 'columbus.dataSources': [{ id: 'old' }], 'columbus.keyPatterns': { 'old/0': 'k:*' }, other: 1 });
	const state = new FileState(root);
	importLegacy(legacy, state);
	assert.deepEqual(state.get('columbus.dataSources'), [{ id: 'old' }]);
	await state.update('columbus.dataSources', []);
	const again = new FileState(root);
	importLegacy(legacy, again);
	assert.deepEqual(again.get('columbus.dataSources'), []);
	assert.deepEqual(again.get('columbus.keyPatterns'), { 'old/0': 'k:*' });
	assert.equal(again.get('other'), undefined);
});

test('nothing is written when there is nothing to import', () => {
	const root = temp();
	importLegacy(memento({}), new FileState(root));
	assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
});
