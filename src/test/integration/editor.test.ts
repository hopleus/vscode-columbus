import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

async function settle<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
	for (let i = 0; i < 50 && !done(read()); i++) {
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return read();
}

const activeLabel = (): string | undefined => vscode.window.tabGroups.activeTabGroup.activeTab?.label;

suite('data editor', () => {
	test('opens a demo table in a webview tab', async () => {
		await vscode.commands.executeCommand('columbus.openTable', 'demo', { database: 'demo', schema: 'public', table: 'users' });
		assert.equal(await settle(activeLabel, label => label === 'users [Demo]'), 'users [Demo]');
		assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview);
	});

	test('a table tab saved before a reload opens the table again', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const labels = (): string[] => vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
		const ref = { database: 'demo', schema: 'public', table: 'orders' };
		await vscode.commands.executeCommand('columbus.test.restorePanel', 'columbus.dataEditor', { restore: { kind: 'table', source: 'demo', ref, where: '' } });
		assert.equal(await settle(activeLabel, label => label === 'orders [Demo]'), 'orders [Demo]');
		await vscode.commands.executeCommand('columbus.openTable', 'demo', ref);
		assert.deepEqual(labels().filter(l => l === 'orders [Demo]'), ['orders [Demo]']);
		for (const [viewType, state] of [
			['columbus.dataEditor', { restore: { kind: 'table', source: 'demo', ref: { ...ref, table: 'missing' }, where: '' } }],
			['columbus.dataEditor', { restore: { kind: 'table', source: 'gone', ref, where: '' } }],
			['columbus.dataEditor', undefined],
			['columbus.redisKey', { restore: { kind: 'redisKey', source: 'gone', db: 0, key: 'k' } }],
			['columbus.dataSource', {}],
			['columbus.result', {}],
		] as const) {
			await vscode.commands.executeCommand('columbus.test.restorePanel', viewType, state);
			assert.deepEqual(await settle(labels, list => !list.includes('Restoring')), ['orders [Demo]'], `${viewType} ${JSON.stringify(state)}`);
		}
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('reuses the tab of a table that is already open', async () => {
		await vscode.commands.executeCommand('columbus.openTable', 'demo', { database: 'demo', schema: 'public', table: 'orders' });
		await settle(activeLabel, label => label === 'orders [Demo]');
		await vscode.commands.executeCommand('columbus.openTable', 'demo', { database: 'demo', schema: 'public', table: 'users' });
		assert.equal(await settle(activeLabel, label => label === 'users [Demo]'), 'users [Demo]');
		const labels = vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
		assert.deepEqual(labels.filter(l => l === 'users [Demo]'), ['users [Demo]']);
	});

	test('Add Data Source opens the data source form, global without a folder', async () => {
		await vscode.commands.executeCommand('columbus.addDataSource');
		assert.equal(await settle(activeLabel, label => label === 'New Global Data Source'), 'New Global Data Source');
		await vscode.commands.executeCommand('columbus.addDataSource');
		const labels = vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
		assert.deepEqual(labels.filter(l => l.startsWith('New ')), ['New Global Data Source']);
	});

	test('without a folder every data source is global', async () => {
		const roots = (global: boolean): Thenable<string[]> => vscode.commands.executeCommand<string[]>('columbus.test.roots', global);
		assert.deepEqual(await roots(false), []);
		assert.ok((await roots(true)).includes('demo'));
		await vscode.commands.executeCommand('columbus.test.move', 'demo', false);
		assert.deepEqual(await roots(false), []);
	});

	test('Open Query Console opens the console of a data source', async () => {
		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'source', id: 'demo', source: { id: 'demo', name: 'Demo' } });
		const label = await settle(activeLabel, value => value === 'console [Demo]');
		assert.equal(label, 'console [Demo]');
		assert.equal(vscode.window.activeTextEditor?.document.languageId, 'columbus-postgres');
		const editor = vscode.workspace.getConfiguration('editor', { languageId: 'columbus-postgres' });
		assert.deepEqual([editor.get('wordBasedSuggestions'), editor.get('suggest.showWords'), editor.get<{ other: string }>('quickSuggestions')?.other], ['off', false, 'on']);
	});

	test('the console completes tables from the catalog', async () => {
		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'source', id: 'demo', source: { id: 'demo', name: 'Demo' } });
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [Demo]'));
		assert.ok(editor);
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT * FROM '));
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, new vscode.Position(0, 14));
		const labels = list.items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
		assert.ok(labels.includes('users'), `got ${labels.slice(0, 20).join(', ')}`);

		const complete = async (text: string): Promise<string[]> => {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
			const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(text.length));
			return result.items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(i => typeof i.label === 'string' ? i.label : i.label.label);
		};
		assert.ok((await complete('SELE')).includes('SELECT'));
		assert.deepEqual((await complete('SELECT * FROM users ')).slice(0, 2), ['WHERE', 'JOIN']);

		const typed = async (text: string, trigger: string): Promise<number> => {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
			const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(text.length), trigger);
			return result.items.length;
		};
		assert.ok(await typed('SELECT * FROM ', ' ') > 0);
		assert.ok(await typed('SELECT * FROM users u WHERE u.', '.') > 0);
		assert.ok(await typed('INSERT INTO users (', '(') > 0);
		assert.equal(await typed('SELECT 1 ', ' '), 0);
		assert.equal(await typed('SELECT 1, ', ','), 0);
	});

	test('the console marks unknown names, colors known ones and expands *', async () => {
		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'source', id: 'demo', source: { id: 'demo', name: 'Demo' } });
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [Demo]'));
		assert.ok(editor);
		const uri = editor.document.uri;
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT u.emial FROM users u;\nSELECT * FROM orders'));
		const diagnostics = await settle(() => vscode.languages.getDiagnostics(uri), found => found.length > 0);
		assert.deepEqual(diagnostics.map(d => d.message), [`Unable to resolve column 'emial'`]);
		const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, diagnostics[0].range);
		assert.ok(fixes.some(f => f.title === `Change to 'email'`), fixes.map(f => f.title).join(', '));
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', uri);
		assert.equal(tokens.data.length / 5, 4);
		const star = editor.document.positionAt(editor.document.getText().lastIndexOf('*'));
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, new vscode.Range(star, star));
		const expand = actions.find(a => a.title === 'Expand column list');
		assert.ok(expand?.edit);
		await vscode.workspace.applyEdit(expand.edit);
		assert.equal(editor.document.lineAt(1).text, 'SELECT id, user_id, total, status, created_at FROM orders');
		assert.deepEqual(await settle(() => vscode.languages.getDiagnostics(uri).length, n => n === 1), 1);
	});

	test('the console runs the selection or the statement under the cursor', async function () {
		const url = process.env.COLUMBUS_PG_URL;
		if (!url) {
			this.skip();
		}
		await vscode.commands.executeCommand('columbus.test.addSource', 'pg', url);
		type Item = { node: unknown; icon: string; description?: string; children: (string | undefined)[] };
		const item = (id: string): Thenable<Item> => vscode.commands.executeCommand<Item>('columbus.test.sourceItem', id);
		const schemasShown = (): Thenable<string[]> => vscode.commands.executeCommand<string[]>('columbus.test.expandSource', 'pg');
		assert.equal((await item('pg')).icon, 'source-postgres.svg');
		await vscode.commands.executeCommand('columbus.test.expandSource', 'pg');
		assert.equal((await item('pg')).icon, 'source-postgres-connected.svg');
		assert.equal((await item('demo')).icon, 'source.svg');
		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'source', id: 'pg', source: { id: 'pg', name: 'pg' } });
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [pg]'));
		assert.ok(editor);
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT 1 AS one;\nSELECT 2 AS two, 3 AS three;\n'));
		type Snapshot = { tabs: string[]; content?: { type: string; results?: { rows?: unknown[][] }[]; message?: string } };
		const results = (): Thenable<Snapshot> => vscode.commands.executeCommand<Snapshot>('columbus.test.results');
		const finished = async (): Promise<Snapshot> => {
			for (let i = 0; i < 50; i++) {
				const snapshot = await results();
				if (snapshot.content && snapshot.content.type !== 'running') {
					return snapshot;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			return results();
		};

		editor.selection = new vscode.Selection(1, 0, 1, 15);
		await vscode.commands.executeCommand('columbus.execute');
		let snapshot = await finished();
		assert.deepEqual(snapshot.content?.results?.[0].rows, [['2']], JSON.stringify(snapshot));

		editor.selection = new vscode.Selection(0, 5, 0, 5);
		await vscode.commands.executeCommand('columbus.execute');
		snapshot = await finished();
		assert.deepEqual(snapshot.content?.results?.[0].rows, [['1']], JSON.stringify(snapshot));
		assert.deepEqual(snapshot.tabs, ['SELECT']);

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT g AS n FROM generate_series(1, 1200) AS g ORDER BY g'));
		editor.selection = new vscode.Selection(0, 3, 0, 3);
		await vscode.commands.executeCommand('columbus.execute');
		snapshot = await finished();
		const first = snapshot.content?.results?.[0].rows ?? [];
		assert.equal(first.length, 500);
		assert.equal((snapshot.content as { more?: boolean }).more, true);
		const page = await vscode.commands.executeCommand<{ rows: unknown[][]; more: boolean }>('columbus.test.page', 'n > 100', 'n DESC', 500, 500);
		assert.deepEqual([page.rows.length, page.rows[0], page.more], [500, ['700'], true]);

		const setup = 'CREATE TABLE IF NOT EXISTS parent (id int PRIMARY KEY); CREATE TABLE IF NOT EXISTS child (id int PRIMARY KEY, parent_id int REFERENCES parent (id))';
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), setup));
		editor.selection = new vscode.Selection(0, 0, 0, setup.length);
		await vscode.commands.executeCommand('columbus.execute');
		await finished();
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT c.id, c.parent_id FROM child c'));
		editor.selection = new vscode.Selection(0, 3, 0, 3);
		await vscode.commands.executeCommand('columbus.execute');
		snapshot = await finished();
		const columns = (snapshot.content as unknown as { results: { columns: { primary?: boolean; foreign?: boolean; references?: unknown }[] }[] }).results[0].columns;
		assert.deepEqual(columns.map(c => [c.primary, c.foreign, c.references]), [
			[true, false, undefined],
			[false, true, { schema: 'public', table: 'parent', column: 'id' }],
		]);

		const offer = async (text: string, kind?: vscode.CompletionItemKind): Promise<{ label: string; insert: string }[]> => {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
			const offset = text.includes('|') ? text.indexOf('|') : text.length;
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text.replace('|', '')));
			const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(offset));
			return list.items
				.filter(i => kind === undefined || i.kind === kind)
				.sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))
				.map(i => ({ label: typeof i.label === 'string' ? i.label : i.label.label, insert: typeof i.insertText === 'string' ? i.insertText : i.insertText?.value ?? '' }));
		};
		const labels = (items: { label: string }[]): string[] => items.map(i => i.label);
		let cte: string[] = [];
		for (let i = 0; i < 20 && !cte.includes('k'); i++) {
			cte = labels(await offer('WITH x AS (SELECT id AS k, parent_id FROM child) SELECT x.| FROM x', vscode.CompletionItemKind.Field));
		}
		assert.deepEqual(cte, ['k', 'parent_id']);
		assert.deepEqual(labels(await offer('SELECT c.| FROM child c', vscode.CompletionItemKind.Field)), ['id', 'parent_id']);
		const on = await offer('SELECT * FROM child c JOIN parent p ');
		assert.ok(on.some(i => i.insert === 'ON p.id = c.parent_id'), JSON.stringify(on.slice(0, 5)));
		assert.deepEqual(labels(await offer('SELECT * FROM child WHERE p', vscode.CompletionItemKind.Field)), ['id', 'parent_id']);
		assert.ok(labels(await offer('INSERT INTO child (')).includes('id, parent_id'));
		assert.ok(labels(await offer('UPDATE child SET ')).includes('parent_id'));

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'CREATE SCHEMA IF NOT EXISTS extra'));
		await vscode.commands.executeCommand('columbus.execute');
		await finished();
		const total = (await schemasShown()).length;
		assert.ok(total >= 2);
		assert.match(String((await item('pg')).description), /^1 of \d+$/);
		assert.equal((await item('pg')).children[0], `${total} of ${total}`);
		await vscode.commands.executeCommand('columbus.test.showSchemas', 'pg', ['extra']);
		assert.equal((await item('pg')).children[0], `1 of ${total}`);
		assert.deepEqual(await schemasShown(), ['extra']);
		await vscode.commands.executeCommand('columbus.test.showSchemas', 'pg', undefined);
		assert.equal((await schemasShown()).length, total);

		const typed = 'SELECT * FROM child WH';
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), typed));
		const started = Date.now();
		const offered = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, new vscode.Position(0, typed.length));
		const keywords = offered.items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(i => typeof i.label === 'string' ? i.label : i.label.label);
		assert.equal(keywords[0], 'WHERE', `${Date.now() - started} ms: ${keywords.join(', ')}`);

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'EXPLAIN SELECT 1'));
		await vscode.commands.executeCommand('columbus.execute');
		snapshot = await finished();
		assert.equal(snapshot.content?.type, 'results');
		const plan = await vscode.commands.executeCommand<{ rows: unknown[][]; more: boolean }>('columbus.test.page', '', '', 0, 500);
		assert.ok(plan.rows.length > 0 && !plan.more);

		const runText = async (text: string, all = false): Promise<Snapshot> => {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
			editor.selection = new vscode.Selection(0, 0, 0, 0);
			await vscode.commands.executeCommand(all ? 'columbus.executeAll' : 'columbus.execute');
			return finished();
		};
		const count = async (): Promise<unknown> => (await runText('SELECT count(*) FROM txt')).content?.results?.[0].rows?.[0][0];
		await runText('CREATE TABLE IF NOT EXISTS txt (id int)');
		await runText('TRUNCATE txt');
		await vscode.commands.executeCommand('columbus.console.toggleTransactionMode');
		await runText('INSERT INTO txt VALUES (1)');
		await vscode.commands.executeCommand('columbus.console.rollback');
		assert.equal(await count(), '0');
		await runText('INSERT INTO txt VALUES (1)');
		await vscode.commands.executeCommand('columbus.console.commit');
		await vscode.commands.executeCommand('columbus.console.toggleTransactionMode');
		assert.equal(await count(), '1');

		snapshot = await runText('SELECT 1 AS a;\nSELECT 2 AS b;\nUPDATE txt SET id = id;\nDELETE FROM txt WHERE false;', true);
		assert.deepEqual(snapshot.tabs, ['SELECT', 'SELECT', 'DELETE']);
		assert.equal(snapshot.content?.type, 'results');

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT 1 AS a FROM parent;\nSELECT 2 AS b FROM child;'));
		for (let i = 0; i < 2; i++) {
			editor.selection = new vscode.Selection(0, 0, 1, 25);
			await vscode.commands.executeCommand('columbus.execute');
			snapshot = await finished();
		}
		assert.deepEqual(snapshot.tabs, ['parent', 'child']);

		await runText('CREATE TABLE IF NOT EXISTS extra.only_here (id int)');
		await runText('SET search_path TO extra, public');
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'SELECT * FROM '));
		const tables = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, new vscode.Position(0, 14));
		assert.ok(tables.items.some(i => (typeof i.label === 'string' ? i.label : i.label.label) === 'only_here'));
		await runText('SET search_path TO public');

		await vscode.commands.executeCommand('columbus.openTable', 'pg', { database: 'columbus', schema: 'public', table: 'txt' });
		assert.equal(await settle(activeLabel, label => label === 'txt [pg]'), 'txt [pg]');
		await vscode.commands.executeCommand('columbus.tree.disconnect', (await item('pg')).node);
		assert.equal((await item('pg')).icon, 'source-postgres.svg');
		assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label)).includes('txt [pg]'));
		const back = await vscode.window.showTextDocument(editor.document);
		await back.edit(edit => edit.replace(new vscode.Range(0, 0, back.document.lineCount, 0), 'SELECT count(*) FROM txt'));
		back.selection = new vscode.Selection(0, 0, 0, 0);
		await vscode.commands.executeCommand('columbus.execute');
		snapshot = await finished();
		assert.equal(snapshot.content?.results?.[0].rows?.[0][0], '1');
		assert.equal((await item('pg')).icon, 'source-postgres-connected.svg');
	});

	test('a Redis key tab saved before a reload opens the key again', async function () {
		const url = process.env.COLUMBUS_REDIS_URL;
		if (!url) {
			this.skip();
		}
		await vscode.commands.executeCommand('columbus.test.addSource', 'restored', url);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('columbus.test.restorePanel', 'columbus.redisKey', { restore: { kind: 'redisKey', source: 'restored', db: 0, key: '0x6bff', bytes: '6bff' } });
		assert.equal(await settle(activeLabel, label => label === '0x6bff [restored]'), '0x6bff [restored]');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('columbus.test.removeSource', 'restored');
	});

	test('Redis sources list databases, run console commands and complete them', async function () {
		const url = process.env.COLUMBUS_REDIS_URL;
		if (!url) {
			this.skip();
		}
		type Snapshot = { tabs: string[]; content?: { type: string; results?: { columns: { name: string }[]; rows?: unknown[][] }[]; message?: string } };
		await vscode.commands.executeCommand('columbus.test.addSource', 'cache', url);
		const item = await vscode.commands.executeCommand<{ node: { source: unknown } }>('columbus.test.sourceItem', 'cache');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('columbus.chooseConsole', item.node);
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [cache]'));
		assert.ok(editor);
		assert.match(editor.document.languageId, /^columbus-(redis|valkey|dragonfly)$/);
		const run = async (text: string): Promise<Snapshot> => {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
			editor.selection = new vscode.Selection(0, 0, editor.document.lineCount - 1, 200);
			await vscode.commands.executeCommand('columbus.execute');
			for (let i = 0; i < 50; i++) {
				const snapshot = await vscode.commands.executeCommand<Snapshot>('columbus.test.results');
				if (snapshot.content && snapshot.content.type !== 'running') {
					return snapshot;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			return vscode.commands.executeCommand<Snapshot>('columbus.test.results');
		};
		let snapshot = await run('SELECT 12\nFLUSHDB\nSET "user:1:name" Ann\nHSET user:1 email ann@example.com name Ann\nHGETALL user:1');
		assert.deepEqual(snapshot.tabs, ['SELECT', 'FLUSHDB', 'SET', 'HSET', 'HGETALL']);
		assert.deepEqual(snapshot.content?.results?.[0].columns.map(c => c.name), ['field', 'value']);
		assert.deepEqual(snapshot.content?.results?.[0].rows, [['email', 'ann@example.com'], ['name', 'Ann']]);
		snapshot = await run('GET nothing-here');
		assert.deepEqual(snapshot.content?.results?.[0].rows, [[null]]);

		const databases = await vscode.commands.executeCommand<string[]>('columbus.test.expandSource', 'cache');
		assert.ok(databases.includes('db12:2'), databases.join(', '));

		const complete = async (text: string): Promise<string[]> => {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
			const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, new vscode.Position(0, text.length));
			return list.items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
		};
		assert.ok((await complete('HGE')).includes('HGETALL'));
		assert.ok((await complete('HGETALL us')).includes('user:1'));
		assert.ok((await complete('SET k v ')).includes('EX'));
		const redisWords = await complete('S');
		assert.ok(!redisWords.some(word => /^(SELECT \*|FROM|WHERE|INSERT INTO|DELETE FROM)$/.test(word)), redisWords.join(', '));
		const select = (await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, new vscode.Position(0, 1))).items
			.find(i => (typeof i.label === 'string' ? i.label : i.label.label) === 'SELECT');
		assert.match(String(select?.detail), /database/i);

		await vscode.commands.executeCommand('columbus.openConsole', { kind: 'source', id: 'demo', source: { id: 'demo', name: 'Demo' } });
		const sql = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.fileName.endsWith('console [Demo]'));
		assert.ok(sql);
		for (const text of ['K', 'SELECT * FROM users WHERE K', 'H']) {
			await sql.edit(edit => edit.replace(new vscode.Range(0, 0, sql.document.lineCount, 0), text));
			const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', sql.document.uri, sql.document.positionAt(text.length));
			const labels = list.items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
			assert.ok(!labels.some(label => /^(KEYS|HGETALL|HSET|LRANGE|EXPIRE|TTL)$/.test(label)), `${text}: ${labels.join(', ')}`);
		}
	});

	test('tree actions copy names, generate statements into the console and show DDL', async () => {
		const ref = { database: 'demo', schema: 'public', table: 'users' };
		const table = {
			name: 'users', kind: 'table', keys: [{ name: 'PRIMARY', columns: ['id'], primary: true }], foreignKeys: [], indexes: [],
			columns: [{ name: 'id', type: 'int', nullable: false, generated: true }, { name: 'email', type: 'text', nullable: false }],
		};
		const source = { id: 'demo', name: 'Demo', driver: { flavor: 'postgres', ddl: async () => 'CREATE TABLE users ();\n' } };
		const node = { kind: 'table', id: 'demo/users', source, ref, table };

		await vscode.commands.executeCommand('columbus.tree.copyQualifiedName', node);
		assert.equal(await vscode.env.clipboard.readText(), '"public"."users"');

		await vscode.commands.executeCommand('columbus.tree.update', node);
		const editor = await settle(() => vscode.window.activeTextEditor, e => !!e?.document.getText().includes('UPDATE "public"."users"'));
		assert.match(editor?.document.getText() ?? '', /UPDATE "public"\."users"\nSET "email" = email\nWHERE "id" = id;$/);

		await vscode.commands.executeCommand('columbus.tree.ddl', node);
		const ddl = await settle(() => vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'columbus-ddl'), e => !!e);
		assert.equal(ddl?.document.getText(), 'CREATE TABLE users ();\n');
		assert.equal(ddl?.document.languageId, 'columbus-postgres');
	});
});

suite('project storage', () => {
	const exclude = (): Record<string, boolean> | undefined => vscode.workspace.getConfiguration('files').inspect<Record<string, boolean>>('exclude')?.globalValue;
	const hide = (project: boolean): Thenable<void> => vscode.commands.executeCommand('columbus.test.hideFolder', project);

	test('without a folder data stays in VS Code storage', async () => {
		const result = await vscode.commands.executeCommand<{ project: boolean }>('columbus.test.storage');
		assert.equal(result.project, false);
	});

	test('a folder keeps its state in a self-ignoring .columbus folder', async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'columbus-it-'));
		const result = await vscode.commands.executeCommand<{ project: boolean; root: string }>('columbus.test.storage', folder);
		assert.equal(result.project, true);
		assert.equal(result.root, path.join(folder, '.columbus'));
		assert.equal(fs.readFileSync(path.join(result.root, '.gitignore'), 'utf8'), '*\n');
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.root, 'state.json'), 'utf8')), { probe: 1 });
		fs.rmSync(folder, { recursive: true, force: true });
	});

	test('the setting switches back to VS Code storage', async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'columbus-it-'));
		const config = vscode.workspace.getConfiguration('columbus');
		await config.update('storage', 'internal', vscode.ConfigurationTarget.Global);
		try {
			const result = await vscode.commands.executeCommand<{ project: boolean }>('columbus.test.storage', folder);
			assert.equal(result.project, false);
			assert.equal(fs.existsSync(path.join(folder, '.columbus')), false);
		} finally {
			await config.update('storage', undefined, vscode.ConfigurationTarget.Global);
			fs.rmSync(folder, { recursive: true, force: true });
		}
	});

	test('a project window hides the folder without touching other exclusions', async () => {
		const files = vscode.workspace.getConfiguration('files');
		const before = exclude();
		await files.update('exclude', { '**/dist': true }, vscode.ConfigurationTarget.Global);
		try {
			await hide(true);
			assert.deepEqual(exclude(), { '**/dist': true, '**/.columbus': true });
			await hide(true);
			assert.deepEqual(exclude(), { '**/dist': true, '**/.columbus': true });
			assert.equal(files.get<Record<string, boolean>>('exclude')?.['**/.git'], true);
		} finally {
			await files.update('exclude', before, vscode.ConfigurationTarget.Global);
		}
	});

	test('a window without a project does not show the folder again', async () => {
		const files = vscode.workspace.getConfiguration('files');
		const before = exclude();
		await files.update('exclude', { '**/.columbus': true }, vscode.ConfigurationTarget.Global);
		try {
			await hide(false);
			assert.deepEqual(exclude(), { '**/.columbus': true });
		} finally {
			await files.update('exclude', before, vscode.ConfigurationTarget.Global);
		}
	});

	test('with the setting off the folder is shown in every window', async () => {
		const files = vscode.workspace.getConfiguration('files');
		const config = vscode.workspace.getConfiguration('columbus');
		const before = exclude();
		await config.update('hideProjectFolder', false, vscode.ConfigurationTarget.Global);
		try {
			for (const project of [true, false]) {
				await files.update('exclude', { '**/dist': true, '**/.columbus': true }, vscode.ConfigurationTarget.Global);
				await hide(project);
				assert.deepEqual(exclude(), { '**/dist': true }, `project ${project}`);
			}
		} finally {
			await config.update('hideProjectFolder', undefined, vscode.ConfigurationTarget.Global);
			await files.update('exclude', before, vscode.ConfigurationTarget.Global);
		}
	});

	test('changing the setting updates files.exclude without a reload', async () => {
		const files = vscode.workspace.getConfiguration('files');
		const config = vscode.workspace.getConfiguration('columbus');
		const before = exclude();
		await files.update('exclude', { '**/dist': true, '**/.columbus': true }, vscode.ConfigurationTarget.Global);
		try {
			await config.update('hideProjectFolder', false, vscode.ConfigurationTarget.Global);
			assert.deepEqual(await settle(exclude, value => !value || !('**/.columbus' in value)), { '**/dist': true });
		} finally {
			await config.update('hideProjectFolder', undefined, vscode.ConfigurationTarget.Global);
			await files.update('exclude', before, vscode.ConfigurationTarget.Global);
		}
	});
});
