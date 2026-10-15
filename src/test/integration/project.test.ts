import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

async function settle<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
	for (let i = 0; i < 50 && !done(read()); i++) {
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return read();
}

type Item = { node: { kind: 'source'; id: string; source: { id: string } }; icon: string } | undefined;

const folder = (): string => vscode.workspace.workspaceFolders![0].uri.fsPath;
const root = (): string => path.join(folder(), '.columbus');
const stateText = (): string => fs.readFileSync(path.join(root(), 'state.json'), 'utf8');
const state = (): Record<string, unknown> => JSON.parse(stateText()) as Record<string, unknown>;
const sourceIds = (): string[] => (state()['columbus.dataSources'] as { id: string }[]).map(s => s.id);
const item = (id: string): Thenable<Item> => vscode.commands.executeCommand<Item>('columbus.test.sourceItem', id);
const roots = (global: boolean): Thenable<string[]> => vscode.commands.executeCommand<string[]>('columbus.test.roots', global);
const globalState = <T>(key: string): Thenable<T | undefined> => vscode.commands.executeCommand<T | undefined>('columbus.test.globalState', key);
const globalRoot = async (): Promise<string> => path.join(await vscode.commands.executeCommand<string>('columbus.test.globalStorage'), 'consoles');
const tabLabels = (): string[] => vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label));

suite('project folder', () => {
	test('the extension starts by itself in a project with a .columbus folder', () => {
		assert.equal(vscode.extensions.getExtension('hopleus.vscode-columbus')?.isActive, true);
	});

	test('data sources of the project are loaded', async () => {
		assert.equal((await item('seeded'))?.icon, 'source-redis.svg');
		assert.equal(await item('../escape'), undefined);
		assert.deepEqual(await roots(false), ['demo', 'seeded']);
		assert.deepEqual(await roots(true), []);
	});

	test('the folder is hidden from the Explorer', async () => {
		const exclude = (): Record<string, boolean> | undefined => vscode.workspace.getConfiguration('files').inspect<Record<string, boolean>>('exclude')?.globalValue;
		assert.equal((await settle(exclude, value => !!value?.['**/.columbus']))?.['**/.columbus'], true);
	});

	test('a saved data source goes to the project and its password does not', async () => {
		await vscode.commands.executeCommand('columbus.test.saveSource', { id: 'added', name: 'added', driver: 'redis', host: '127.0.0.1', port: 2, database: '0', user: '', ssl: 'disable' }, 'secret-password');
		assert.deepEqual(sourceIds(), ['seeded', 'added']);
		assert.ok(!stateText().includes('secret-password'));
		assert.equal((await item('added'))?.icon, 'source-redis.svg');
		assert.equal(fs.readFileSync(path.join(root(), '.gitignore'), 'utf8'), '*\n');
	});

	test('schema filters are kept in the project', async () => {
		await vscode.commands.executeCommand('columbus.test.showSchemas', 'added', ['public']);
		assert.deepEqual(state()['columbus.visibleSchemas'], { added: ['public'] });
	});

	test('SQL consoles and their database are kept in the project', async () => {
		const demo = await item('demo');
		assert.ok(demo);
		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'database', source: demo.node.source, database: { name: 'demo' } });
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [Demo]'));
		assert.ok(editor);
		assert.equal(path.dirname(editor.document.uri.fsPath), path.join(root(), 'consoles', 'demo'));
		assert.equal((state()['columbus.consoleDatabases'] as Record<string, string>)[editor.document.uri.toString()], 'demo');
	});

	test('Redis consoles are kept in the project', async () => {
		const seeded = await item('seeded');
		assert.ok(seeded);
		await vscode.commands.executeCommand('columbus.openConsole', seeded.node);
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [seeded]'));
		assert.ok(editor);
		assert.equal(path.dirname(editor.document.uri.fsPath), path.join(root(), 'consoles', 'seeded'));
		assert.equal(editor.document.languageId, 'columbus-redis');
	});

	test('a data source id from the project never points outside the consoles folder', async () => {
		const consoles = path.join(root(), 'consoles');
		for (const id of ['..', '../..', 'a/../..', '']) {
			await vscode.commands.executeCommand('columbus.test.forgetSource', id);
			assert.ok(fs.existsSync(consoles), id);
			assert.ok(fs.existsSync(path.join(root(), 'state.json')), id);
		}
		assert.deepEqual(sourceIds(), ['seeded', 'added']);
	});

	test('removing a data source removes its filters and Redis consoles from the project', async () => {
		await vscode.commands.executeCommand('columbus.test.showSchemas', 'seeded', ['s']);
		await vscode.commands.executeCommand('columbus.test.showDatabases', 'seeded', ['d']);
		await vscode.commands.executeCommand('columbus.test.keyPattern', 'seeded', 0, 'user:*');
		await vscode.commands.executeCommand('columbus.test.keyPattern', 'added', 1, 'cache:*');
		await vscode.commands.executeCommand('columbus.test.forgetSource', 'seeded');
		assert.deepEqual(sourceIds(), ['added']);
		assert.deepEqual(state()['columbus.visibleSchemas'], { added: ['public'] });
		assert.deepEqual(state()['columbus.visibleDatabases'], {});
		assert.deepEqual(state()['columbus.keyPatterns'], { 'added/1': 'cache:*' });
		assert.equal(fs.existsSync(path.join(root(), 'consoles', 'seeded')), false);
		assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'console [seeded]')));
		assert.equal(await item('seeded'), undefined);
	});

	test('removing a data source removes its SQL consoles and their database', async () => {
		await vscode.commands.executeCommand('columbus.test.forgetSource', 'demo');
		assert.equal(fs.existsSync(path.join(root(), 'consoles', 'demo')), false);
		assert.deepEqual(state()['columbus.consoleDatabases'], {});
		assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'console [Demo]')));
		assert.equal(await item('demo'), undefined);
	});

	test('a global data source is kept in the global storage folder, not in globalState', async () => {
		await vscode.commands.executeCommand('columbus.test.saveSource', { id: 'shared', name: 'shared', driver: 'redis', host: '127.0.0.1', port: 3, database: '0', user: '', ssl: 'disable' }, 'shared-password', true);
		assert.deepEqual(await roots(true), ['shared']);
		assert.ok(!(await roots(false)).includes('shared'));
		assert.deepEqual((await globalState<{ id: string }[]>('columbus.dataSources'))?.map(s => s.id), ['shared']);
		const file = path.join(await vscode.commands.executeCommand<string>('columbus.test.globalStorage'), 'state.json');
		assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8'))['columbus.dataSources'] as { id: string }[]).map(s => s.id), ['shared']);
		assert.equal(await vscode.commands.executeCommand('columbus.test.legacyState', 'columbus.dataSources'), undefined);
		assert.ok(!sourceIds().includes('shared'));
		assert.ok(!stateText().includes('shared-password'));
		assert.ok(!fs.readFileSync(file, 'utf8').includes('shared-password'));
	});

	test('Make Project moves a data source with its password, filters and consoles', async () => {
		await vscode.commands.executeCommand('columbus.test.keyPattern', 'shared', 0, 'k:*');
		assert.deepEqual(await globalState('columbus.keyPatterns'), { 'shared/0': 'k:*' });
		const shared = await item('shared');
		assert.ok(shared);
		await vscode.commands.executeCommand('columbus.openConsole', shared.node);
		await settle(tabLabels, labels => labels.includes('console [shared]'));
		assert.ok(fs.existsSync(path.join(await globalRoot(), 'shared', 'console [shared]')));

		await vscode.commands.executeCommand('columbus.test.move', 'shared', false);
		assert.ok((await roots(false)).includes('shared'));
		assert.deepEqual(await roots(true), []);
		assert.ok(sourceIds().includes('shared'));
		assert.deepEqual(await globalState('columbus.dataSources'), []);
		assert.equal((state()['columbus.keyPatterns'] as Record<string, string>)['shared/0'], 'k:*');
		assert.deepEqual(await globalState('columbus.keyPatterns'), {});
		assert.ok(fs.existsSync(path.join(root(), 'consoles', 'shared', 'console [shared]')));
		assert.equal(fs.existsSync(path.join(await globalRoot(), 'shared')), false);
		assert.ok(!tabLabels().includes('console [shared]'));
		assert.equal(await vscode.commands.executeCommand('columbus.test.password', 'shared'), 'shared-password');
	});

	test('dragging a data source to Global moves its SQL consoles and their database', async () => {
		await vscode.commands.executeCommand('columbus.test.saveSource', { id: 'lite', name: 'lite', driver: 'sqlite', host: '', port: 0, database: path.join(folder(), 'lite.db'), user: '', ssl: 'disable' }, '', false);
		const lite = await item('lite');
		assert.ok(lite);
		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'database', source: lite.node.source, database: { name: 'main' } });
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [lite]'));
		assert.ok(editor);
		const fileName = path.basename(editor.document.uri.fsPath);
		assert.equal((state()['columbus.consoleDatabases'] as Record<string, string>)[editor.document.uri.toString()], 'main');

		await vscode.commands.executeCommand('columbus.test.dragAndDrop', 'lite', true);
		assert.deepEqual(await roots(true), ['lite']);
		assert.ok(!sourceIds().includes('lite'));
		assert.ok(fs.existsSync(path.join(await globalRoot(), 'lite', fileName)));
		assert.equal(fs.existsSync(path.join(root(), 'consoles', 'lite')), false);
		const databases = Object.entries(await globalState<Record<string, string>>('columbus.consoleDatabases') ?? {});
		assert.equal(databases.length, 1);
		assert.ok(databases[0][0].endsWith(`/consoles/lite/${encodeURIComponent(fileName)}`), databases[0][0]);
		assert.equal(databases[0][1], 'main');
		assert.ok(!Object.keys(state()['columbus.consoleDatabases'] as Record<string, string>).some(key => key.includes('/lite/')));
	});

	test('removing a global data source removes it from VS Code global storage', async () => {
		await vscode.commands.executeCommand('columbus.test.forgetSource', 'lite');
		assert.deepEqual(await roots(true), []);
		assert.deepEqual(await globalState('columbus.dataSources'), []);
		assert.deepEqual(await globalState('columbus.consoleDatabases'), {});
		assert.equal(fs.existsSync(path.join(await globalRoot(), 'lite')), false);
	});

	test('each section adds data sources to its own place', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('columbus.addProjectDataSource');
		await vscode.commands.executeCommand('columbus.addGlobalDataSource');
		await vscode.commands.executeCommand('columbus.addDataSource');
		assert.deepEqual((await settle(tabLabels, labels => labels.length === 2)).sort(), ['New Data Source', 'New Global Data Source']);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('data sources of Columbus 0.1.0 show up in Global with their consoles', async () => {
		const legacy = { id: 'legacy', name: 'legacy', driver: 'redis', host: '127.0.0.1', port: 4, database: '0', user: '', ssl: 'disable' };
		await vscode.commands.executeCommand('columbus.test.legacyState', 'columbus.dataSources', [legacy]);
		await vscode.commands.executeCommand('columbus.test.legacyState', 'columbus.keyPatterns', { 'legacy/0': 'k:*' });
		fs.rmSync(path.join(await vscode.commands.executeCommand<string>('columbus.test.globalStorage'), 'state.json'));
		fs.mkdirSync(path.join(await globalRoot(), 'legacy'), { recursive: true });
		fs.writeFileSync(path.join(await globalRoot(), 'legacy', 'console [legacy]'), 'PING\n');
		await vscode.commands.executeCommand('columbus.test.load');
		assert.deepEqual(await roots(true), ['legacy']);
		assert.ok(!(await roots(false)).includes('legacy'));
		assert.deepEqual(await globalState('columbus.keyPatterns'), { 'legacy/0': 'k:*' });
		const found = await item('legacy');
		assert.ok(found);
		await vscode.commands.executeCommand('columbus.openConsole', found.node);
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [legacy]'));
		assert.equal(editor?.document.getText(), 'PING\n');
	});
});
