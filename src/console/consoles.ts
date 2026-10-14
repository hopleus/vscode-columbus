import * as vscode from 'vscode';
import { gridColumns } from '../catalog';
import type { Catalog, TableInfo } from '../catalog';
import type { SchemaFilter } from '../explorer/schemas';
import type { ExecuteResult } from '../drivers/driver';
import { QUOTES, quoteIdentifier } from '../shared/format';
import type { Flavor } from '../shared/format';
import { wordAt } from '../shared/sql-assist';
import type { Value } from '../shared/protocol';
import { summary } from '../shared/results-protocol';
import { splitStatements, statementAt } from '../shared/statements';
import type { StatementRange } from '../shared/statements';
import { isRedis } from '../sources';
import type { DataSource, Sources } from '../sources';
import { consoleSuggestions, shouldPopup, tableReferences } from './assist';
import type { ConsoleSuggestion } from './assist';
import type { AssistClient } from './assist-client';
import { ALIAS, countSql, pageSql, pageable, selectItems } from './paging';
import { ConsoleLanguage, SQL_SELECTOR, sqlLanguage } from './language';
import { columnListSuggestions, smartSuggestions, wordStart } from './smart';
import type { QueryTab, ResultsView } from './results';

const PAGE_SIZE = 500;
const SCHEMA_CHANGE = /^\s*(create|alter|drop|rename|truncate|comment)\b/i;

const KINDS: Record<ConsoleSuggestion['kind'], vscode.CompletionItemKind> = {
	table: vscode.CompletionItemKind.Struct,
	view: vscode.CompletionItemKind.Interface,
	column: vscode.CompletionItemKind.Field,
	schema: vscode.CompletionItemKind.Module,
	keyword: vscode.CompletionItemKind.Keyword,
	function: vscode.CompletionItemKind.Function,
};

interface Located {
	text: string;
	start: number;
	end: number;
}

interface Status {
	start: number;
	end: number;
	ok: boolean;
	elapsed: number;
}

function bounds(text: string, statement: StatementRange): Located {
	const start = statement.start + Math.max(0, text.slice(statement.start).indexOf(statement.text));
	return { text: statement.text, start, end: start + statement.text.length };
}

function frameType(width: string): vscode.TextEditorDecorationType {
	return vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderWidth: width,
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor('columbus.currentStatementBorder'),
	});
}

function describe(suggestion: ConsoleSuggestion): string | undefined {
	if (suggestion.kind === 'function' || suggestion.kind === 'schema' || suggestion.detail === 'keyword' || suggestion.detail === 'function' || suggestion.detail === 'schema') {
		return undefined;
	}
	return [suggestion.owner, suggestion.detail].filter(Boolean).join(' · ') || undefined;
}

const FROM = /\bfrom\s+((?:[\w$]+|"[^"]+"|`[^`]+`)(?:\.(?:[\w$]+|"[^"]+"|`[^`]+`))?)/i;

export function resultTitle(sql: string): string {
	const from = FROM.exec(sql)?.[1];
	if (from && /^\s*(select|with|table)\b/i.test(sql)) {
		return (from.split('.').pop() ?? from).replace(/^["`]|["`]$/g, '');
	}
	return /^\s*(\w+)/.exec(sql)?.[1].toUpperCase() ?? 'Result';
}

const CONSOLE_FILE = /^(console(?:_\d+)?) \[.*\](?:\.sql)?$/;
const CONSOLE_DATABASES = 'columbus.consoleDatabases';

interface ConsoleFile {
	base: string;
	uri: vscode.Uri;
	mtime: number;
}

function fileName(base: string, source: DataSource): string {
	return `${base} [${source.name.replace(/[\\/:*?"<>|]/g, '_')}]`;
}

export class Consoles implements vscode.Disposable {
	private readonly running = new Map<string, { source: DataSource; session: string; cancelled: boolean }>();
	private readonly adopting = new Set<string>();
	private readonly transactions = new Map<string, { manual: boolean; open: boolean }>();
	private readonly currentSchemas = new Map<string, string>();
	private readonly language: ConsoleLanguage;
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	private readonly schemaStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	private readonly txStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	private readonly frame = {
		single: frameType('1px'),
		top: frameType('1px 1px 0 1px'),
		middle: frameType('0 1px 0 1px'),
		bottom: frameType('0 1px 1px 1px'),
	};
	private readonly statusOk: vscode.TextEditorDecorationType;
	private readonly statusFailed: vscode.TextEditorDecorationType;
	private readonly timing = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2ch' },
	});
	private readonly statuses = new Map<string, Status[]>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		extensionUri: vscode.Uri,
		private readonly storage: vscode.Uri,
		private readonly sources: Sources,
		private readonly results: ResultsView,
		private readonly assist: AssistClient,
		private readonly state: vscode.Memento,
		private readonly filter: SchemaFilter
	) {
		this.status.tooltip = 'Columbus data source of this console';
		const gutter = (name: string): vscode.TextEditorDecorationType => vscode.window.createTextEditorDecorationType({
			light: { gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'light', `${name}.svg`) },
			dark: { gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'dark', `${name}.svg`) },
			gutterIconSize: 'contain',
		});
		this.statusOk = gutter('status-ok');
		this.statusFailed = gutter('status-error');
		this.language = new ConsoleLanguage(document => {
			const source = this.sourceOf(document);
			const catalog = source && this.sources.loaded(source.id);
			return source && catalog && { catalog: this.scoped(document, source, catalog), flavor: source.driver.flavor };
		});
		this.schemaStatus.command = 'columbus.console.chooseSchema';
		this.schemaStatus.tooltip = 'Current schema of this console: click to switch';
		this.txStatus.command = 'columbus.console.toggleTransactionMode';
		results.onCancel = key => void this.cancelKey(key);
		results.queries = {
			page: (query, where, orderBy, offset, limit) => this.page(query, where, orderBy, offset, limit),
			count: (query, where) => this.count(query, where),
			cancel: query => this.cancelQuery(query),
			navigate: (query, schema, table, where) => this.navigate(query, schema, table, where),
			locate: query => this.locate(query),
			openInConsole: query => this.appendToConsole(query),
		};
		this.disposables.push(
			this.language,
			sources.onDidLoadCatalog(() => this.language.refresh()),
			this.status,
			this.schemaStatus,
			this.txStatus,
			...Object.values(this.frame),
			this.statusOk,
			this.statusFailed,
			this.timing,
			vscode.window.onDidChangeActiveTextEditor(editor => {
				this.updateContext();
				this.decorate(editor);
				if (editor) {
					void this.adopt(editor.document);
				}
				if (editor) {
					this.renderStatuses(editor.document);
				}
				if (editor && this.sourceOf(editor.document)) {
					results.showConsole(editor.document.uri.toString());
					const source = this.sourceOf(editor.document);
					if (source && sources.isConnected(source.id) && !this.currentSchemas.has(editor.document.uri.toString())) {
						void this.refreshSchema(editor.document);
					}
				}
			}),
			vscode.window.onDidChangeTextEditorSelection(event => this.decorate(event.textEditor)),
			vscode.workspace.onDidChangeTextDocument(event => {
				this.shiftStatuses(event);
				const editor = vscode.window.activeTextEditor;
				if (editor?.document === event.document) {
					this.decorate(editor);
				}
			}),
			sources.onDidChangeConnection(id => {
				if (!sources.isConnected(id)) {
					this.forget(id);
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => this.release(document)),
			vscode.workspace.onDidOpenTextDocument(document => void this.adopt(document)),
			sources.onDidChange(() => {
				this.adoptAll();
				this.updateContext();
			}),
			vscode.languages.registerCompletionItemProvider(SQL_SELECTOR, {
				provideCompletionItems: (document, position, _token, context) => this.complete(document, position, context),
			}, '.', ' ', '(', ',')
		);
		this.adoptAll();
		this.updateContext();
	}

	private adoptAll(): void {
		for (const document of vscode.workspace.textDocuments) {
			void this.adopt(document);
		}
	}

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	private get root(): vscode.Uri {
		return vscode.Uri.joinPath(this.storage, 'consoles');
	}

	async open(source: DataSource, database?: string): Promise<void> {
		const existing = (await this.files(source)).find(file => file.base === 'console');
		const uri = existing?.uri ?? await this.create(source, 'console');
		if (database) {
			await this.useDatabase(source, uri.toString(), database);
		}
		await this.show(uri);
	}

	async insert(source: DataSource, snippet: string, database?: string): Promise<void> {
		await this.open(source, database);
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const document = editor.document;
		const end = document.lineAt(document.lineCount - 1).range.end;
		const prefix = document.getText().trim() ? '\n\n' : '';
		await editor.insertSnippet(new vscode.SnippetString(`${prefix}${snippet}`), end);
	}

	private async locate(query: QueryTab): Promise<void> {
		const uri = vscode.Uri.parse(query.session.replace(/^(console|redis):/, ''));
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		const offset = editor.document.getText().indexOf(query.sql);
		if (offset < 0) {
			void vscode.window.showInformationMessage('Columbus: the statement is no longer in the console');
			return;
		}
		editor.selection = new vscode.Selection(editor.document.positionAt(offset), editor.document.positionAt(offset + query.sql.length));
		editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	async choose(source: DataSource): Promise<void> {
		type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
		const files = await this.files(source);
		const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
		const items: Item[] = [
			{ label: '$(terminal) Default Query Console', run: () => this.open(source) },
			...(files.length ? [separator('Recent Consoles')] : []),
			...files.map((file): Item => ({ label: file.base, description: file.base === 'console' ? 'Default' : undefined, run: () => this.show(file.uri) })),
			separator(''),
			{ label: '$(add) New Query Console', run: async () => this.show(await this.create(source, this.nextName(files))) },
			{ label: '$(folder-opened) Show Console Folder', run: () => this.reveal(source) },
		];
		const picked = await vscode.window.showQuickPick(items, { title: `Query Consoles of ${source.name}` });
		await picked?.run?.();
	}

	private async files(source: DataSource): Promise<ConsoleFile[]> {
		const folder = vscode.Uri.joinPath(this.root, source.id);
		await vscode.workspace.fs.createDirectory(folder);
		const open = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
		const files: ConsoleFile[] = [];
		for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
			if (type !== vscode.FileType.File || !(CONSOLE_FILE.test(name) || name.endsWith('.sql'))) {
				continue;
			}
			const base = CONSOLE_FILE.exec(name)?.[1] ?? name.replace(/\.sql$/, '');
			let uri = vscode.Uri.joinPath(folder, name);
			const wanted = vscode.Uri.joinPath(folder, fileName(base, source));
			if (CONSOLE_FILE.test(name) && name !== fileName(base, source) && !open.has(uri.toString())) {
				await vscode.workspace.fs.rename(uri, wanted);
				uri = wanted;
			}
			files.push({ base, uri, mtime: (await vscode.workspace.fs.stat(uri)).mtime });
		}
		return files.sort((a, b) => b.mtime - a.mtime);
	}

	private nextName(files: readonly ConsoleFile[]): string {
		const numbers = files.map(file => Number(/^console_(\d+)$/.exec(file.base)?.[1] ?? 0));
		return `console_${Math.max(0, ...numbers) + 1}`;
	}

	private async create(source: DataSource, base: string): Promise<vscode.Uri> {
		const uri = vscode.Uri.joinPath(this.root, source.id, fileName(base, source));
		await vscode.workspace.fs.writeFile(uri, new Uint8Array());
		return uri;
	}

	private async show(uri: vscode.Uri): Promise<void> {
		const source = this.sourceOfUri(uri);
		if (source) {
			void this.sources.catalog(source).catch(() => undefined);
		}
		const document = await this.adopt(await vscode.workspace.openTextDocument(uri));
		await vscode.window.showTextDocument(document, { preview: false });
	}

	private async adopt(document: vscode.TextDocument): Promise<vscode.TextDocument> {
		const source = this.sourceOf(document);
		if (!source) {
			return document;
		}
		this.assist.warm(source.driver.flavor);
		const language = sqlLanguage(source.driver.flavor, source.product);
		if (document.languageId === language) {
			return document;
		}
		const key = document.uri.toString();
		this.adopting.add(key);
		try {
			return await vscode.languages.setTextDocumentLanguage(document, language);
		} finally {
			this.adopting.delete(key);
		}
	}

	private async reveal(source: DataSource): Promise<void> {
		const folder = vscode.Uri.joinPath(this.root, source.id);
		await vscode.workspace.fs.createDirectory(folder);
		await vscode.commands.executeCommand('revealFileInOS', folder.scheme === 'file' ? folder : vscode.Uri.file(folder.path));
	}

	async execute(editor = vscode.window.activeTextEditor): Promise<void> {
		const target = this.target(editor);
		if (!target) {
			return;
		}
		const statements = this.statements(target.editor, target.source);
		if (!statements.length) {
			void vscode.window.showInformationMessage('Columbus: there is no statement at the cursor');
			return;
		}
		await this.run(target.editor.document, target.source, statements);
	}

	async executeAll(editor = vscode.window.activeTextEditor): Promise<void> {
		const target = this.target(editor);
		if (!target) {
			return;
		}
		const text = target.editor.document.getText();
		const statements = splitStatements(text, target.source.driver.flavor).map(statement => bounds(text, statement));
		if (!statements.length) {
			void vscode.window.showInformationMessage('Columbus: the console has no statements');
			return;
		}
		await this.run(target.editor.document, target.source, statements);
	}

	async finishTransaction(command: 'COMMIT' | 'ROLLBACK', editor = vscode.window.activeTextEditor): Promise<void> {
		const target = this.target(editor);
		if (!target) {
			return;
		}
		const { document } = target.editor;
		const key = document.uri.toString();
		if (this.running.has(key)) {
			void vscode.window.showInformationMessage('Columbus: wait for the running statement to finish');
			return;
		}
		const entry = { time: new Date().toLocaleTimeString(), source: target.source.name, sql: command };
		try {
			await target.source.driver.execute(command, this.session(document), this.databaseOf(key, target.source));
			this.results.log(key, { ...entry, text: command === 'COMMIT' ? 'Committed' : 'Rolled back', failed: false });
		} catch (err) {
			this.results.log(key, { ...entry, text: (err as Error).message, failed: true });
			void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
		} finally {
			this.transaction(key).open = false;
			this.updateContext();
		}
		await this.refreshSchema(document);
	}

	async toggleTransactionMode(editor = vscode.window.activeTextEditor): Promise<void> {
		const target = this.target(editor);
		if (!target) {
			return;
		}
		const tx = this.transaction(target.editor.document.uri.toString());
		if (tx.manual && tx.open) {
			const answer = await vscode.window.showWarningMessage(
				'The console has an open transaction',
				{ modal: true, detail: 'Commit or roll it back before switching to auto-commit.' },
				'Commit',
				'Rollback'
			);
			if (!answer) {
				return;
			}
			await this.finishTransaction(answer === 'Commit' ? 'COMMIT' : 'ROLLBACK', target.editor);
		}
		tx.manual = !tx.manual;
		this.updateContext();
	}

	async chooseSchema(editor = vscode.window.activeTextEditor): Promise<void> {
		const target = this.target(editor);
		if (!target) {
			return;
		}
		const { source } = target;
		if (source.driver.flavor === 'sqlite') {
			void vscode.window.showInformationMessage('Columbus: SQLite looks up unqualified names in main, temp and attached databases');
			return;
		}
		const { document } = target.editor;
		const key = document.uri.toString();
		const catalog = await this.sources.catalog(source).catch(() => undefined);
		const current = this.currentSchemas.get(key);
		const names = [...new Set(catalog?.databases.flatMap(d => d.schemas.map(s => s.name)) ?? [])].sort((a, b) => a.localeCompare(b));
		const picked = await vscode.window.showQuickPick(names.map(name => ({ label: name, description: name === current ? 'current' : undefined })), {
			title: `Current Schema of ${source.name}`,
			placeHolder: 'Schema for unqualified names in this console',
		});
		if (!picked) {
			return;
		}
		if (this.running.has(key)) {
			void vscode.window.showInformationMessage('Columbus: wait for the running statement to finish');
			return;
		}
		const flavor = source.driver.flavor;
		const name = quoteIdentifier(picked.label, QUOTES[flavor]);
		const sql = flavor === 'mysql' ? `USE ${name}` : `SET search_path TO ${name}${picked.label === 'public' ? '' : ', public'}`;
		const entry = { time: new Date().toLocaleTimeString(), source: source.name, sql };
		try {
			await source.driver.execute(sql, this.session(document), this.databaseOf(key, source));
			this.results.log(key, { ...entry, text: `Current schema: ${picked.label}`, failed: false });
		} catch (err) {
			this.results.log(key, { ...entry, text: (err as Error).message, failed: true });
			void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
		}
		await this.refreshSchema(document);
	}

	private target(editor: vscode.TextEditor | undefined): { editor: vscode.TextEditor; source: DataSource } | undefined {
		const source = editor && this.sourceOf(editor.document);
		if (!editor || !source) {
			void vscode.window.showInformationMessage('Columbus: open a query console of a data source to run SQL');
			return undefined;
		}
		return { editor, source };
	}

	private async run(document: vscode.TextDocument, source: DataSource, statements: readonly Located[]): Promise<void> {
		const key = document.uri.toString();
		if (this.running.has(key)) {
			void vscode.window.showInformationMessage('Columbus: the previous statement of this console is still running');
			return;
		}
		const session = this.session(document);
		const run = { source, session, cancelled: false };
		this.running.set(key, run);
		this.updateContext();
		this.results.replaceUnpinned(key);
		try {
			let fresh = false;
			for (const statement of statements) {
				if (run.cancelled) {
					break;
				}
				const started = Date.now();
				const outcome = await this.runStatement(key, run, statement.text, fresh);
				this.setStatus(document, { start: statement.start, end: statement.end, ok: outcome !== 'failed', elapsed: Date.now() - started });
				if (outcome === 'failed') {
					break;
				}
				fresh = outcome === 'rows';
			}
		} finally {
			this.running.delete(key);
			this.updateContext();
			void this.refreshSchema(document);
		}
	}

	private async runStatement(key: string, run: { source: DataSource; session: string; cancelled: boolean }, sql: string, fresh: boolean): Promise<'rows' | 'done' | 'failed'> {
		const { source, session } = run;
		const flavor = source.driver.flavor;
		const database = this.databaseOf(key, source);
		const query: QueryTab = { source, flavor, session, database, sql, pageable: pageable(sql, flavor) };
		const tab = this.results.start(key, resultTitle(sql), { type: 'running', source: source.name, sql }, query, fresh);
		const started = Date.now();
		const log = (text: string, failed: boolean): void => this.results.log(key, {
			time: new Date().toLocaleTimeString(),
			source: source.name,
			sql,
			text,
			failed,
		});
		try {
			await this.beginIfManual(key, source, session);
			let results: ExecuteResult[];
			if (query.pageable) {
				try {
					results = await source.driver.execute(pageSql(sql, '', '', PAGE_SIZE + 1, 0), session, database);
				} catch (err) {
					if (flavor !== 'mysql' || run.cancelled) {
						throw err;
					}
					query.pageable = false;
					results = await source.driver.execute(sql, session, database);
				}
			} else {
				results = await source.driver.execute(sql, session, database);
			}
			await this.annotate(source, sql, results);
			let more = false;
			const rows = [...results].reverse().find(r => r.kind === 'rows');
			if (rows?.kind === 'rows') {
				if (!query.pageable) {
					query.cache = rows.rows;
				}
				more = rows.rows.length > PAGE_SIZE;
				rows.rows = rows.rows.slice(0, PAGE_SIZE);
			}
			const elapsed = Date.now() - started;
			this.results.update(key, tab, { type: 'results', source: source.name, sql, elapsed, results, flavor, more });
			log(`${results.map(r => summary(r, r === rows && more)).join(' · ')} in ${elapsed} ms`, false);
			if (SCHEMA_CHANGE.test(sql)) {
				this.sources.refresh(source.id);
			}
			this.trackTransaction(key, sql);
			return rows ? 'rows' : 'done';
		} catch (err) {
			const message = (err as Error).message;
			this.results.update(key, tab, { type: 'error', source: source.name, sql, elapsed: Date.now() - started, message });
			log(message, true);
			return 'failed';
		}
	}

	private transaction(key: string): { manual: boolean; open: boolean } {
		let tx = this.transactions.get(key);
		if (!tx) {
			tx = { manual: false, open: false };
			this.transactions.set(key, tx);
		}
		return tx;
	}

	private async beginIfManual(key: string, source: DataSource, session: string): Promise<void> {
		const tx = this.transaction(key);
		if (tx.manual && !tx.open) {
			await source.driver.execute(source.driver.flavor === 'mysql' ? 'START TRANSACTION' : 'BEGIN', session, this.databaseOf(key, source));
			tx.open = true;
		}
	}

	private trackTransaction(key: string, sql: string): void {
		const tx = this.transaction(key);
		if (/^\s*(commit|end|abort)\b/i.test(sql) || (/^\s*rollback\b/i.test(sql) && !/^\s*rollback\s+to\b/i.test(sql))) {
			tx.open = false;
		} else if (/^\s*(begin|start\s+transaction)\b/i.test(sql)) {
			tx.open = true;
		}
	}

	private async refreshSchema(document: vscode.TextDocument): Promise<void> {
		const source = this.sourceOf(document);
		const key = document.uri.toString();
		if (!source || this.running.has(key) || source.driver.flavor === 'sqlite') {
			return;
		}
		try {
			const [result] = await source.driver.execute(source.driver.flavor === 'mysql' ? 'SELECT DATABASE()' : 'SELECT current_schema()', this.session(document), this.databaseOf(key, source));
			const value = result?.kind === 'rows' ? result.rows[0]?.[0] : undefined;
			const schema = value === null || value === undefined ? '' : String(value);
			if (this.currentSchemas.get(key) !== schema) {
				this.currentSchemas.set(key, schema);
				this.language.refresh();
			}
		} catch {
			return;
		}
		this.updateContext();
	}

	async page(query: QueryTab, where: string, orderBy: string, offset: number, limit: number): Promise<{ rows: Value[][]; more: boolean }> {
		if (!query.pageable) {
			if (where.trim() || orderBy.trim()) {
				throw new Error('Filtering and sorting work only for SELECT statements');
			}
			const rows = query.cache ?? [];
			return { rows: rows.slice(offset, offset + limit), more: offset + limit < rows.length };
		}
		const [result] = await this.sqlOf(query).driver.execute(pageSql(query.sql, where, orderBy, limit + 1, offset), query.session, query.database);
		const rows = result?.kind === 'rows' ? result.rows : [];
		return { rows: rows.slice(0, limit), more: rows.length > limit };
	}

	async count(query: QueryTab, where: string): Promise<number> {
		if (!query.pageable) {
			return query.cache?.length ?? 0;
		}
		const [result] = await this.sqlOf(query).driver.execute(countSql(query.sql, where), query.session, query.database);
		return result?.kind === 'rows' ? Number(result.rows[0]?.[0] ?? 0) : 0;
	}

	private sqlOf(query: QueryTab): DataSource {
		if (isRedis(query.source)) {
			throw new Error('Not available for Redis results');
		}
		return query.source;
	}

	private async appendToConsole(query: QueryTab): Promise<void> {
		const uri = vscode.Uri.parse(query.session.replace(/^(console|redis):/, ''));
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		const document = editor.document;
		const end = document.lineAt(document.lineCount - 1).range.end;
		const text = isRedis(query.source) ? query.sql : `${query.sql};`;
		const prefix = document.getText().trim() ? '\n\n' : '';
		await editor.edit(edit => edit.insert(end, `${prefix}${text}`));
		const start = document.positionAt(document.offsetAt(end) + prefix.length);
		editor.selection = new vscode.Selection(start, document.positionAt(document.offsetAt(start) + text.length));
		editor.revealRange(editor.selection);
	}

	async navigate(query: QueryTab, schema: string, table: string, where: string): Promise<void> {
		const catalog = await this.sources.catalog(this.sqlOf(query));
		const database = catalog.databases.find(d => d.schemas.some(s => s.name === schema))?.name ?? '';
		await vscode.commands.executeCommand('columbus.openTable', query.source.id, { database, schema, table }, where);
	}

	private async annotate(source: DataSource, sql: string, results: ExecuteResult[]): Promise<void> {
		if (!results.some(r => r.kind === 'rows' && r.columns.some(c => c.origin))) {
			return;
		}
		const catalog = await this.sources.catalog(source).catch(() => undefined);
		const schemas = catalog?.databases.flatMap(d => d.schemas) ?? [];
		const references = tableReferences(sql);
		const find = (schema: string, name: string): { schema: string; table: TableInfo } | undefined => {
			const direct = schemas.find(s => s.name === schema)?.tables.find(t => t.name === name);
			if (direct) {
				return { schema, table: direct };
			}
			const aliased = references.get(name.toLowerCase());
			const owner = aliased && aliased.length > 1 ? aliased[aliased.length - 2] : schema;
			const table = aliased && schemas.find(s => s.name === owner)?.tables.find(t => t.name === aliased[aliased.length - 1]);
			return table ? { schema: owner, table } : undefined;
		};
		const items = selectItems(sql, source.driver.flavor);
		const positional = items && !items.some(item => item.star) ? items : undefined;
		const owner = (schema: string, column: string): string | undefined => {
			const owners = new Set<string>();
			for (const names of references.values()) {
				const owned = names.length > 1 ? names[names.length - 2] : schema;
				const table = schemas.find(s => s.name === owned)?.tables.find(t => t.name === names[names.length - 1]);
				if (table?.columns.some(c => c.name === column)) {
					owners.add(table.name);
				}
			}
			return owners.size === 1 ? [...owners][0] : undefined;
		};
		for (const result of results) {
			if (result.kind !== 'rows') {
				continue;
			}
			for (const [index, column] of result.columns.entries()) {
				let origin = column.origin;
				const item = positional?.[index];
				if (origin?.table === ALIAS) {
					const table = item?.column ? item.qualifier ?? owner(origin.schema, item.column) : undefined;
					origin = item?.column && table ? { schema: origin.schema, table, column: item.column } : undefined;
					column.origin = origin;
				}
				const found = origin && find(origin.schema, origin.table);
				const columns = found ? gridColumns(found.table, found.schema) : [];
				const info = columns.find(c => c.name === origin?.column) ?? columns.find(c => c.name === item?.column);
				if (origin && found && info) {
					column.origin = { schema: found.schema, table: found.table.name, column: info.name };
					column.type = info.type;
					column.primary = info.primary;
					column.foreign = info.foreign;
					column.references = info.references;
				}
			}
		}
	}

	async cancelQuery(query: QueryTab): Promise<void> {
		await query.source.driver.cancel(query.session);
	}

	async cancel(editor = vscode.window.activeTextEditor): Promise<void> {
		const key = editor?.document.uri.toString();
		const running = key && this.running.has(key) ? key : [...this.running.keys()][0];
		if (running) {
			await this.cancelKey(running);
		}
	}

	private async cancelKey(key: string): Promise<void> {
		const run = this.running.get(key);
		if (!run) {
			return;
		}
		if (run.cancelled) {
			const answer = await vscode.window.showWarningMessage(
				`The statement in ${run.source.name} is still running. Disconnect the data source to stop it?`,
				{ modal: true, detail: 'All connections of this data source are closed, open transactions are rolled back.' },
				'Disconnect'
			);
			if (answer === 'Disconnect') {
				run.source.driver.disconnect();
			}
			return;
		}
		run.cancelled = true;
		try {
			await run.source.driver.cancel(run.session);
		} catch (err) {
			void vscode.window.showErrorMessage(`Columbus: could not cancel the statement: ${(err as Error).message}`);
		}
	}

	private statements(editor: vscode.TextEditor, source: DataSource): Located[] {
		const document = editor.document;
		if (!editor.selection.isEmpty) {
			const selected = document.getText(editor.selection);
			const base = document.offsetAt(editor.selection.start);
			return splitStatements(selected, source.driver.flavor).map(statement => {
				const located = bounds(selected, statement);
				return { text: located.text, start: base + located.start, end: base + located.end };
			});
		}
		const text = document.getText();
		const found = statementAt(splitStatements(text, source.driver.flavor), text, document.offsetAt(editor.selection.active));
		return found ? [bounds(text, found)] : [];
	}

	private setStatus(document: vscode.TextDocument, status: Status): void {
		const key = document.uri.toString();
		const list = (this.statuses.get(key) ?? []).filter(s => s.end <= status.start || s.start >= status.end);
		list.push(status);
		this.statuses.set(key, list);
		this.renderStatuses(document);
	}

	private shiftStatuses(event: vscode.TextDocumentChangeEvent): void {
		const key = event.document.uri.toString();
		const list = this.statuses.get(key);
		if (!list?.length || !event.contentChanges.length) {
			return;
		}
		const changes = event.contentChanges.map(c => ({ start: c.rangeOffset, end: c.rangeOffset + c.rangeLength, delta: c.text.length - c.rangeLength }));
		const shifted = list
			.filter(s => !changes.some(c => c.start <= s.end && c.end >= s.start))
			.map(s => {
				const delta = changes.filter(c => c.end <= s.start).reduce((sum, c) => sum + c.delta, 0);
				return { ...s, start: s.start + delta, end: s.end + delta };
			});
		this.statuses.set(key, shifted);
		this.renderStatuses(event.document);
	}

	private renderStatuses(document: vscode.TextDocument): void {
		const list = this.statuses.get(document.uri.toString()) ?? [];
		const line = (offset: number): vscode.Range => {
			const position = document.positionAt(offset);
			return new vscode.Range(position.line, 0, position.line, 0);
		};
		for (const editor of vscode.window.visibleTextEditors.filter(e => e.document === document)) {
			editor.setDecorations(this.statusOk, list.filter(s => s.ok).map(s => line(s.start)));
			editor.setDecorations(this.statusFailed, list.filter(s => !s.ok).map(s => line(s.start)));
			editor.setDecorations(this.timing, list.filter(s => s.ok).map(s => {
				const end = document.positionAt(s.end);
				const lineEnd = document.lineAt(end.line).range.end;
				return { range: new vscode.Range(lineEnd, lineEnd), renderOptions: { after: { contentText: `${s.elapsed} ms` } } };
			}));
		}
	}

	private databaseOf(key: string, source: DataSource): string | undefined {
		const stored = this.state.get<Record<string, string>>(CONSOLE_DATABASES, {})[key];
		if (stored) {
			return stored;
		}
		const catalog = this.sources.loaded(source.id);
		return catalog && !catalog.schemasOnly ? catalog.databases[0]?.name : undefined;
	}

	private scoped(document: vscode.TextDocument, source: DataSource, catalog: Catalog): Catalog {
		const database = this.databaseOf(document.uri.toString(), source);
		const current = this.currentSchemas.get(document.uri.toString());
		const databases = catalog.databases.length > 1 && database ? catalog.databases.filter(d => d.name === database) : catalog.databases;
		return { ...catalog, databases, ...(current ? { current } : {}) };
	}

	private async useDatabase(source: DataSource, key: string, database: string): Promise<void> {
		const all = { ...this.state.get<Record<string, string>>(CONSOLE_DATABASES, {}) };
		if (all[key] === database) {
			return;
		}
		all[key] = database;
		await this.state.update(CONSOLE_DATABASES, all);
		const tx = this.transactions.get(key);
		if (tx) {
			tx.open = false;
		}
		this.currentSchemas.delete(key);
		const catalog = await this.sources.catalog(source).catch(() => undefined);
		if (catalog && !catalog.schemasOnly && !catalog.databases.some(d => d.name === database)) {
			await this.filter.setDatabases(source.id, [...catalog.databases.map(d => d.name), database]);
			this.sources.refresh(source.id);
		}
		this.language.refresh();
		this.updateContext();
	}

	async chooseDatabase(editor = vscode.window.activeTextEditor): Promise<void> {
		const target = this.target(editor);
		if (!target) {
			return;
		}
		const { source } = target;
		const key = target.editor.document.uri.toString();
		const catalog = await this.sources.catalog(source).catch(() => undefined);
		if (!catalog?.available || catalog.schemasOnly) {
			void vscode.window.showInformationMessage(`Columbus: ${source.name} has one database`);
			return;
		}
		if (this.running.has(key)) {
			void vscode.window.showInformationMessage('Columbus: wait for the running statement to finish');
			return;
		}
		const current = this.databaseOf(key, source);
		const picked = await vscode.window.showQuickPick(catalog.available.map(name => ({ label: name, description: name === current ? 'current' : undefined })), {
			title: `Database of this console`,
			placeHolder: 'Statements of this console run in the chosen database',
		});
		if (!picked || picked.label === current) {
			return;
		}
		if (this.transactions.get(key)?.open) {
			const answer = await vscode.window.showWarningMessage(`Switch to ${picked.label}?`, { modal: true, detail: 'The open transaction of this console will be rolled back.' }, 'Switch');
			if (answer !== 'Switch') {
				return;
			}
		}
		await this.useDatabase(source, key, picked.label);
		await this.refreshSchema(target.editor.document);
	}

	private sourceOf(document: vscode.TextDocument): DataSource | undefined {
		return this.sourceOfUri(document.uri);
	}

	private sourceOfUri(uri: vscode.Uri): DataSource | undefined {
		const root = this.root;
		const prefix = `${root.path}/`;
		if (uri.scheme !== root.scheme || uri.authority !== root.authority || !uri.path.startsWith(prefix)) {
			return undefined;
		}
		return this.sources.sql(decodeURIComponent(uri.path.slice(prefix.length).split('/')[0]));
	}

	private session(document: vscode.TextDocument): string {
		return `console:${document.uri.toString()}`;
	}

	uncommitted(sourceId: string): string[] {
		return [...this.transactions].filter(([key, tx]) => tx.open && this.sourceOfUri(vscode.Uri.parse(key))?.id === sourceId)
			.map(([key]) => decodeURIComponent(key.split('/').pop() ?? key));
	}

	private forget(sourceId: string): void {
		for (const key of new Set([...this.transactions.keys(), ...this.currentSchemas.keys()])) {
			if (this.sourceOfUri(vscode.Uri.parse(key))?.id === sourceId) {
				const tx = this.transactions.get(key);
				if (tx) {
					tx.open = false;
				}
				this.currentSchemas.delete(key);
			}
		}
		this.updateContext();
	}

	private decorate(editor: vscode.TextEditor | undefined): void {
		const source = editor && this.sourceOf(editor.document);
		if (!editor || !source) {
			return;
		}
		const lines = { single: [] as vscode.Range[], top: [] as vscode.Range[], middle: [] as vscode.Range[], bottom: [] as vscode.Range[] };
		if (editor.selection.isEmpty) {
			const text = editor.document.getText();
			const found = statementAt(splitStatements(text, source.driver.flavor), text, editor.document.offsetAt(editor.selection.active));
			if (found) {
				const located = bounds(text, found);
				const first = editor.document.positionAt(located.start).line;
				const last = editor.document.positionAt(located.end).line;
				const at = (line: number): vscode.Range => new vscode.Range(line, 0, line, 0);
				if (first === last) {
					lines.single.push(at(first));
				} else {
					lines.top.push(at(first));
					for (let line = first + 1; line < last; line++) {
						lines.middle.push(at(line));
					}
					lines.bottom.push(at(last));
				}
			}
		}
		for (const part of ['single', 'top', 'middle', 'bottom'] as const) {
			editor.setDecorations(this.frame[part], lines[part]);
		}
	}

	private release(document: vscode.TextDocument): void {
		const source = this.sourceOf(document);
		if (source && !this.adopting.has(document.uri.toString())) {
			this.transactions.delete(document.uri.toString());
			this.currentSchemas.delete(document.uri.toString());
			this.statuses.delete(document.uri.toString());
			this.results.drop(document.uri.toString());
			void source.driver.rollback(this.session(document)).catch(() => undefined);
		}
	}

	private updateContext(): void {
		const document = vscode.window.activeTextEditor?.document;
		const source = document && this.sourceOf(document);
		void vscode.commands.executeCommand('setContext', 'columbus.consoleActive', !!source);
		void vscode.commands.executeCommand('setContext', 'columbus.consoleRunning', !!document && this.running.has(document.uri.toString()));
		const key = document?.uri.toString() ?? '';
		const tx = source ? this.transaction(key) : undefined;
		void vscode.commands.executeCommand('setContext', 'columbus.consoleManual', !!tx?.manual);
		void vscode.commands.executeCommand('setContext', 'columbus.consoleTxOpen', !!tx?.open);
		if (source && tx) {
			const database = source.kind === 'postgres' ? this.databaseOf(key, source) : undefined;
			this.status.text = `$(database) ${source.name}${database ? ` · ${database}` : ''}`;
			this.status.command = source.kind === 'postgres' ? 'columbus.console.chooseDatabase' : undefined;
			this.status.tooltip = source.kind === 'postgres' ? 'Database of this console: click to switch' : 'Columbus data source of this console';
			this.status.show();
			const schema = this.currentSchemas.get(key);
			if (schema === undefined) {
				this.schemaStatus.hide();
			} else {
				this.schemaStatus.text = `$(symbol-namespace) ${schema || '<no schema>'}`;
				this.schemaStatus.show();
			}
			this.txStatus.text = tx.manual ? `${tx.open ? '$(circle-filled) ' : ''}Tx: Manual` : 'Tx: Auto';
			this.txStatus.tooltip = tx.manual
				? `Statements run in a transaction${tx.open ? ' that is open now' : ''}; Commit or Rollback ends it. Click for auto-commit.`
				: 'Every statement is committed on its own. Click for manual transactions.';
			this.txStatus.show();
		} else {
			this.status.hide();
			this.schemaStatus.hide();
			this.txStatus.hide();
		}
	}

	private async suggestionsAt(document: vscode.TextDocument, offset: number): Promise<{ suggestions: ConsoleSuggestion[]; before: string; flavor: Flavor } | undefined> {
		const source = this.sourceOf(document);
		if (!source) {
			return undefined;
		}
		const flavor = source.driver.flavor;
		const text = document.getText();
		const statement = statementAt(splitStatements(text, flavor), text, offset);
		const start = statement && statement.start <= offset ? statement.start : offset;
		const before = text.slice(start, offset);
		if (!wordAt(before, before.length, flavor)) {
			return undefined;
		}
		const loaded = await this.sources.catalog(source).catch(() => undefined);
		if (!loaded) {
			return undefined;
		}
		const catalog = this.scoped(document, source, loaded);
		const statementText = statement && statement.start <= offset ? text.slice(statement.start, Math.max(statement.end, offset)) : before;
		const opening = !before.slice(0, wordStart(before)).trim();
		const analysis = opening ? undefined : await this.assist.analyze(flavor, statementText, wordStart(before));
		const suggestions = analysis
			? smartSuggestions(catalog, analysis, statementText, before, flavor)
			: columnListSuggestions(catalog, before, flavor) ?? consoleSuggestions(catalog, statementText, before, flavor);
		return { suggestions, before, flavor };
	}

	private async complete(document: vscode.TextDocument, position: vscode.Position, context: vscode.CompletionContext): Promise<vscode.CompletionList> {
		const found = await this.suggestionsAt(document, document.offsetAt(position));
		if (!found || (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter && !shouldPopup(found.before, found.flavor, found.suggestions))) {
			return new vscode.CompletionList([], true);
		}
		const items = found.suggestions.map((suggestion, index) => {
			const item = new vscode.CompletionItem({ label: suggestion.kind === 'function' ? `${suggestion.label}()` : suggestion.label, description: describe(suggestion) }, KINDS[suggestion.kind]);
			item.filterText = suggestion.label;
			item.insertText = suggestion.snippet ? new vscode.SnippetString(suggestion.insert) : suggestion.insert;
			item.sortText = `${suggestion.sort}${String(index).padStart(5, '0')}`;
			if (suggestion.retrigger) {
				item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
			}
			return item;
		});
		return new vscode.CompletionList(items, !/[\w$]$/.test(found.before));
	}
}
