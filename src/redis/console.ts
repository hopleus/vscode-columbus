import * as vscode from 'vscode';
import type { ResultsView, QueryTab } from '../console/results';
import type { ExecuteResult } from '../drivers/driver';
import type { RedisArgument, RedisCommandDoc } from '../drivers/redis';
import { summary } from '../shared/results-protocol';
import type { RedisSource, Sources } from '../sources';
import type { Places } from '../storage';
import { isRedis } from '../sources';
import { parseCommand, replyRows } from './values';

export const REDIS_LANGUAGES = { redis: 'columbus-redis', valkey: 'columbus-valkey', dragonfly: 'columbus-dragonfly' } as const;
const REDIS_SELECTOR = Object.values(REDIS_LANGUAGES).map(language => ({ language }));

function redisLanguage(source: RedisSource): string {
	return source.product === 'valkey' || source.product === 'dragonfly' ? REDIS_LANGUAGES[source.product] : REDIS_LANGUAGES.redis;
}
const PAGE = 500;
const KNOWN_TOKENS: Record<string, string[]> = {
	SET: ['EX', 'PX', 'EXAT', 'PXAT', 'NX', 'XX', 'KEEPTTL', 'GET'],
	GETEX: ['EX', 'PX', 'EXAT', 'PXAT', 'PERSIST'],
	EXPIRE: ['NX', 'XX', 'GT', 'LT'],
	PEXPIRE: ['NX', 'XX', 'GT', 'LT'],
	ZADD: ['NX', 'XX', 'GT', 'LT', 'CH', 'INCR'],
	ZRANGE: ['BYSCORE', 'BYLEX', 'REV', 'LIMIT', 'WITHSCORES'],
	ZRANGEBYSCORE: ['WITHSCORES', 'LIMIT'],
	SCAN: ['MATCH', 'COUNT', 'TYPE'],
	HSCAN: ['MATCH', 'COUNT', 'NOVALUES'],
	SSCAN: ['MATCH', 'COUNT'],
	ZSCAN: ['MATCH', 'COUNT'],
	XADD: ['NOMKSTREAM', 'MAXLEN', 'MINID', 'LIMIT'],
	XRANGE: ['COUNT'],
	XREAD: ['COUNT', 'BLOCK', 'STREAMS'],
	LPOS: ['RANK', 'COUNT', 'MAXLEN'],
	RESTORE: ['REPLACE', 'ABSTTL', 'IDLETIME', 'FREQ'],
	COPY: ['DB', 'REPLACE'],
	FLUSHDB: ['ASYNC', 'SYNC'],
	FLUSHALL: ['ASYNC', 'SYNC'],
	CLIENT: ['LIST', 'KILL', 'ID', 'INFO', 'SETNAME', 'GETNAME'],
	CONFIG: ['GET', 'SET', 'RESETSTAT', 'REWRITE'],
};

function syntax(doc: RedisCommandDoc): string {
	const render = (arg: RedisArgument): string => {
		let text = arg.type === 'pure-token' ? arg.token ?? arg.name : arg.arguments?.length
			? (arg.type === 'oneof' ? arg.arguments.map(render).join(' | ') : arg.arguments.map(render).join(' '))
			: `${arg.token ? `${arg.token} ` : ''}${arg.name}`;
		if (arg.type === 'oneof' && arg.arguments?.length && !arg.optional) {
			text = `<${text}>`;
		}
		if (arg.multiple) {
			text = `${text} [${text} ...]`;
		}
		return arg.optional ? `[${text}]` : text;
	};
	return [doc.name, ...doc.arguments.map(render)].join(' ');
}

function tokensOf(args: readonly RedisArgument[]): string[] {
	return args.flatMap(arg => [...(arg.token ? [arg.token] : []), ...tokensOf(arg.arguments ?? [])]);
}

function looseTokens(line: string): string[] {
	return line.match(/"(?:[^"\\]|\\.)*"?|'[^']*'?|\S+/g) ?? [];
}

export class RedisConsoles implements vscode.Disposable {
	private readonly running = new Map<string, { source: RedisSource; session: string; cancelled: boolean }>();
	private readonly databases = new Map<string, number>();
	private readonly docs = new Map<string, Promise<RedisCommandDoc[]>>();
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	private readonly dbStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly adopting = new Set<string>();

	constructor(private readonly places: Places, private readonly sources: Sources, private readonly results: ResultsView) {
		this.status.tooltip = 'Columbus data source of this console';
		this.dbStatus.command = 'columbus.redis.chooseDatabase';
		this.dbStatus.tooltip = 'Database of this console: click to switch';
		this.disposables.push(
			this.status,
			this.dbStatus,
			vscode.window.onDidChangeActiveTextEditor(editor => {
				this.updateContext();
				if (editor) {
					void this.adopt(editor.document);
				}
				if (editor && this.sourceOf(editor.document)) {
					this.results.showConsole(editor.document.uri.toString());
				}
			}),
			vscode.workspace.onDidOpenTextDocument(document => void this.adopt(document)),
			vscode.workspace.onDidCloseTextDocument(document => this.release(document)),
			sources.onDidChange(() => {
				this.docs.clear();
				for (const document of vscode.workspace.textDocuments) {
					void this.adopt(document);
				}
				this.updateContext();
			}),
			vscode.languages.registerCompletionItemProvider(REDIS_SELECTOR, {
				provideCompletionItems: (document, position) => this.complete(document, position),
			}, ' ')
		);
		for (const document of vscode.workspace.textDocuments) {
			void this.adopt(document);
		}
		this.updateContext();
	}

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	owns(editor = vscode.window.activeTextEditor): boolean {
		return !!editor && !!this.sourceOf(editor.document);
	}

	async open(source: RedisSource, db?: number): Promise<void> {
		const name = `console [${source.name.replace(/[\\/:*?"<>|]/g, '_')}]`;
		const root = vscode.Uri.joinPath(this.places.of(source.global).uri, 'consoles');
		const uri = vscode.Uri.joinPath(root, source.id, name);
		const legacy = vscode.Uri.joinPath(root, source.id, `${name}.redis`);
		const exists = async (target: vscode.Uri): Promise<boolean> => vscode.workspace.fs.stat(target).then(() => true, () => false);
		if (!await exists(uri)) {
			if (await exists(legacy) && !vscode.workspace.textDocuments.some(d => d.uri.toString() === legacy.toString())) {
				await vscode.workspace.fs.rename(legacy, uri);
			} else {
				await vscode.workspace.fs.writeFile(uri, Buffer.from(''));
			}
		}
		if (db !== undefined && !this.running.has(uri.toString())) {
			this.databases.set(uri.toString(), db);
			await source.driver.release(this.session(uri)).catch(() => undefined);
		}
		const document = await this.adopt(await vscode.workspace.openTextDocument(uri));
		await vscode.window.showTextDocument(document, { preview: false });
		this.updateContext();
	}

	async execute(editor = vscode.window.activeTextEditor): Promise<void> {
		const document = editor?.document;
		const source = document && this.sourceOf(document);
		if (!editor || !document || !source) {
			return;
		}
		const lines = (editor.selection.isEmpty ? [document.lineAt(editor.selection.active.line).text] : document.getText(editor.selection).split(/\r?\n/))
			.map(line => line.trim())
			.filter(line => line && !line.startsWith('#') && !line.startsWith('//'));
		if (!lines.length) {
			void vscode.window.showInformationMessage('Columbus: there is no command on this line');
			return;
		}
		const key = document.uri.toString();
		if (this.running.has(key)) {
			void vscode.window.showInformationMessage('Columbus: the previous command of this console is still running');
			return;
		}
		const run = { source, session: this.session(document.uri), cancelled: false };
		this.running.set(key, run);
		this.updateContext();
		this.results.replaceUnpinned(key);
		try {
			let fresh = false;
			for (const line of lines) {
				if (run.cancelled || !(await this.run(key, run, line, fresh))) {
					break;
				}
				fresh = true;
			}
		} finally {
			this.running.delete(key);
			this.updateContext();
		}
	}

	async cancel(editor = vscode.window.activeTextEditor): Promise<void> {
		const run = editor && this.running.get(editor.document.uri.toString());
		if (run) {
			run.cancelled = true;
			await run.source.driver.cancel(run.session).catch(() => false);
		}
	}

	async chooseDatabase(editor = vscode.window.activeTextEditor): Promise<void> {
		const document = editor?.document;
		const source = document && this.sourceOf(document);
		if (!document || !source) {
			return;
		}
		const key = document.uri.toString();
		const current = this.databases.get(key) ?? source.database;
		const databases = await source.driver.databases();
		const picked = await vscode.window.showQuickPick(databases.map(d => ({
			label: `db${d.index}`,
			description: `${d.keys.toLocaleString('en-US')} keys${d.index === current ? ' · current' : ''}`,
			index: d.index,
		})), { title: `Database of ${source.name}` });
		if (picked) {
			const { db } = await source.driver.execute(this.session(document.uri), current, ['SELECT', String(picked.index)]);
			this.databases.set(key, db);
			this.updateContext();
		}
	}

	private async run(key: string, run: { source: RedisSource; session: string }, line: string, fresh: boolean): Promise<boolean> {
		const { source, session } = run;
		const query: QueryTab = { source, flavor: 'postgres', session, sql: line, pageable: false };
		const started = Date.now();
		const log = (text: string, failed: boolean): void => this.results.log(key, { time: new Date().toLocaleTimeString(), source: source.name, sql: line, text, failed });
		let args: string[];
		try {
			args = parseCommand(line);
		} catch (err) {
			log((err as Error).message, true);
			return false;
		}
		const tab = this.results.start(key, args[0]?.toUpperCase() ?? 'Result', { type: 'running', source: source.name, sql: line }, query, fresh);
		try {
			const { reply, db } = await source.driver.execute(session, this.databases.get(key) ?? source.database, args);
			this.databases.set(key, db);
			const { columns, rows } = replyRows(args, reply);
			query.cache = rows;
			const result: ExecuteResult = {
				kind: 'rows',
				columns: columns.map((name, i) => ({ name, type: '', numeric: rows.length > 0 && rows.every(row => typeof row[i] === 'number') })),
				rows: rows.slice(0, PAGE),
				truncated: false,
			};
			const elapsed = Date.now() - started;
			this.results.update(key, tab, { type: 'results', source: source.name, sql: line, elapsed, results: [result], flavor: 'postgres', more: rows.length > PAGE });
			log(`${summary(result, rows.length > PAGE)} in ${elapsed} ms`, false);
			if (/^(DEL|UNLINK|SET|HSET|RENAME|EXPIRE|PERSIST|FLUSHDB|FLUSHALL|LPUSH|RPUSH|SADD|ZADD|XADD|COPY|MOVE|RESTORE)$/i.test(args[0] ?? '')) {
				this.sources.refresh(source.id);
			}
			return true;
		} catch (err) {
			const message = (err as Error).message;
			this.results.update(key, tab, { type: 'error', source: source.name, sql: line, elapsed: Date.now() - started, message });
			log(message, true);
			return false;
		} finally {
			this.updateContext();
		}
	}

	private sourceOf(document: vscode.TextDocument): RedisSource | undefined {
		const uri = document.uri;
		for (const place of this.places.all()) {
			const root = vscode.Uri.joinPath(place.uri, 'consoles');
			if (uri.scheme === root.scheme && uri.authority === root.authority && uri.path.startsWith(`${root.path}/`)) {
				const source = this.sources.get(decodeURIComponent(uri.path.slice(root.path.length + 1).split('/')[0]));
				return source && isRedis(source) ? source : undefined;
			}
		}
		return undefined;
	}

	private session(uri: vscode.Uri): string {
		return `redis:${uri.toString()}`;
	}

	private async adopt(document: vscode.TextDocument): Promise<vscode.TextDocument> {
		const source = this.sourceOf(document);
		if (!source || document.languageId === redisLanguage(source)) {
			return document;
		}
		const key = document.uri.toString();
		this.adopting.add(key);
		try {
			return await vscode.languages.setTextDocumentLanguage(document, redisLanguage(source));
		} finally {
			this.adopting.delete(key);
		}
	}

	private release(document: vscode.TextDocument): void {
		const source = this.sourceOf(document);
		const key = document.uri.toString();
		if (source && !this.adopting.has(key)) {
			this.results.drop(key);
			this.databases.delete(key);
			void source.driver.release(this.session(document.uri)).catch(() => undefined);
		}
	}

	private updateContext(): void {
		const document = vscode.window.activeTextEditor?.document;
		const source = document && this.sourceOf(document);
		void vscode.commands.executeCommand('setContext', 'columbus.redisConsoleActive', !!source);
		void vscode.commands.executeCommand('setContext', 'columbus.redisConsoleRunning', !!document && this.running.has(document.uri.toString()));
		if (source && document) {
			this.status.text = `$(database) ${source.name}`;
			this.dbStatus.text = `db${this.databases.get(document.uri.toString()) ?? source.database}`;
			this.status.show();
			this.dbStatus.show();
		} else {
			this.status.hide();
			this.dbStatus.hide();
		}
	}

	private commandDocs(source: RedisSource): Promise<RedisCommandDoc[]> {
		let docs = this.docs.get(source.id);
		if (!docs) {
			docs = source.driver.commands();
			docs.catch(() => this.docs.delete(source.id));
			this.docs.set(source.id, docs);
		}
		return docs;
	}

	private async complete(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionList | undefined> {
		const source = this.sourceOf(document);
		if (!source) {
			return undefined;
		}
		const before = document.lineAt(position.line).text.slice(0, position.character);
		if (/^\s*(#|\/\/)/.test(before)) {
			return undefined;
		}
		const prefix = /\S*$/.exec(before)?.[0] ?? '';
		const tokens = looseTokens(before.slice(0, before.length - prefix.length));
		const docs = await this.commandDocs(source).catch(() => [] as RedisCommandDoc[]);
		const range = new vscode.Range(position.translate(0, -prefix.length), position);
		if (!tokens.length) {
			return new vscode.CompletionList(docs.filter(doc => !doc.name.includes(' ')).map(doc => this.commandItem(doc, range)));
		}
		const name = tokens[0].toUpperCase();
		const subcommands = docs.filter(doc => doc.name.startsWith(`${name} `));
		if (tokens.length === 1 && subcommands.length) {
			return new vscode.CompletionList(subcommands.map(doc => this.commandItem(doc, range, doc.name.slice(name.length + 1))));
		}
		const doc = docs.find(d => d.name === `${name} ${tokens[1]?.toUpperCase()}`) ?? docs.find(d => d.name === name);
		const items: vscode.CompletionItem[] = [];
		if (doc) {
			const used = new Set(tokens.map(t => t.toUpperCase()));
			for (const token of new Set(doc.arguments.length ? tokensOf(doc.arguments) : KNOWN_TOKENS[name] ?? [])) {
				if (!used.has(token.toUpperCase())) {
					const item = new vscode.CompletionItem(token, vscode.CompletionItemKind.Keyword);
					item.range = range;
					item.detail = syntax(doc);
					item.sortText = `2${token}`;
					items.push(item);
				}
			}
			const position = tokens.length - (doc.name.includes(' ') ? 2 : 1);
			const keyed = doc.arguments.some((arg, i) => arg.type === 'key' && (i === position || (arg.multiple && i <= position)));
			if (keyed || !doc.arguments.length) {
				items.push(...await this.keyItems(source, document, prefix, range));
			}
		}
		return new vscode.CompletionList(items, true);
	}

	private commandItem(doc: RedisCommandDoc, range: vscode.Range, label = doc.name): vscode.CompletionItem {
		const item = new vscode.CompletionItem({ label, description: doc.group }, vscode.CompletionItemKind.Function);
		item.range = range;
		item.insertText = `${label} `;
		item.detail = doc.summary;
		item.documentation = new vscode.MarkdownString().appendCodeblock(syntax(doc), 'text').appendMarkdown(doc.since ? `\n\nSince ${doc.since}` : '');
		item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
		return item;
	}

	private async keyItems(source: RedisSource, document: vscode.TextDocument, prefix: string, range: vscode.Range): Promise<vscode.CompletionItem[]> {
		const pattern = `${prefix.replace(/^["']/, '').replace(/[*?[\]\\]/g, '\\$&')}*`;
		const db = this.databases.get(document.uri.toString()) ?? source.database;
		try {
			const reply = await source.driver.command(db, ['SCAN', '0', 'MATCH', pattern, 'COUNT', '1000']);
			const keys = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1].map(String) : [];
			return [...new Set(keys)].sort().slice(0, 200).map(key => {
				const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
				item.range = range;
				item.insertText = /[\s"']/.test(key) ? `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : key;
				item.sortText = `1${key}`;
				return item;
			});
		} catch {
			return [];
		}
	}
}
