import * as vscode from 'vscode';
import type { RedisArg, RedisKey, RedisValue } from '../drivers/redis';
import { showSql } from '../editor/definitions';
import { exportRows } from '../editor/export';
import { registerGridTarget } from '../editor/grid-menu';
import { gridHtml } from '../editor/panel';
import { parseOrder } from '../shared/format';
import type { HostMessage, Value, ViewMessage } from '../shared/protocol';
import type { RedisSource, Sources } from '../sources';
import { isRedis } from '../sources';
import { collection, commandLine, commandsFor, formatTtl, hexColumns, jsonCollection } from './values';
import type { Collection } from './values';

export const SCHEME = 'columbus-redis';
const LIMIT = 10000;
const JSON_TYPE = 'ReJSON-RL';

export interface KeyTarget {
	source: RedisSource;
	db: number;
	key: string;
	bytes?: Uint8Array;
}

export const keyArg = (target: KeyTarget): RedisArg => target.bytes ?? target.key;

export const nameArg = (key: RedisKey): RedisArg => key.bytes ?? key.name;

export function keyUri(target: KeyTarget): vscode.Uri {
	const name = target.key.split('/').pop() || target.key;
	return vscode.Uri.from({
		scheme: SCHEME,
		path: `/${target.source.name}/db${target.db}/${name}`,
		query: new URLSearchParams({ source: target.source.id, db: String(target.db), key: target.key, ...(target.bytes ? { bytes: Buffer.from(target.bytes).toString('hex') } : {}) }).toString(),
	});
}

export class RedisStrings implements vscode.FileSystemProvider {
	private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changed.event;
	private readonly mtimes = new Map<string, number>();

	constructor(private readonly sources: Sources) { }

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const value = await this.read(uri);
		const key = uri.toString();
		const mtime = this.mtimes.get(key) ?? Date.now();
		this.mtimes.set(key, mtime);
		return {
			type: vscode.FileType.File,
			ctime: mtime,
			mtime,
			size: value.text.length,
			...(value.writable ? {} : { permissions: vscode.FilePermission.Readonly }),
		};
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return Buffer.from((await this.read(uri)).text, 'utf8');
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		const key = keyArg(this.target(uri));
		const { source, db } = this.target(uri);
		const text = Buffer.from(content).toString('utf8');
		const value = await source.driver.value(db, key, 1);
		if (value.type === 'other' && value.name === JSON_TYPE) {
			await source.driver.command(db, ['JSON.SET', key, '$', JSON.stringify(JSON.parse(text))]);
		} else {
			await source.driver.setString(db, key, text);
		}
		this.mtimes.set(uri.toString(), Date.now());
		this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	readDirectory(): never {
		throw vscode.FileSystemError.NoPermissions('Redis keys are not folders');
	}

	createDirectory(): never {
		throw vscode.FileSystemError.NoPermissions('Redis keys are not folders');
	}

	delete(): never {
		throw vscode.FileSystemError.NoPermissions('Delete keys in Database Explorer');
	}

	rename(): never {
		throw vscode.FileSystemError.NoPermissions('Rename keys in Database Explorer');
	}

	target(uri: vscode.Uri): KeyTarget {
		const params = new URLSearchParams(uri.query);
		const source = this.sources.get(params.get('source') ?? '');
		if (!source || !isRedis(source)) {
			throw vscode.FileSystemError.Unavailable('The data source of this key was removed');
		}
		const bytes = params.get('bytes');
		return { source, db: Number(params.get('db')) || 0, key: params.get('key') ?? '', ...(bytes ? { bytes: Uint8Array.from(Buffer.from(bytes, 'hex')) } : {}) };
	}

	private async read(uri: vscode.Uri): Promise<{ text: string; writable: boolean }> {
		const { source, db } = this.target(uri);
		const key = keyArg(this.target(uri));
		const value = await source.driver.value(db, key, 1);
		if (value.type === 'none') {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (value.type === 'string') {
			return { text: value.value, writable: !value.binary };
		}
		if (value.type === 'other' && value.name === JSON_TYPE) {
			const reply = await source.driver.command(db, ['JSON.GET', key]);
			return { text: JSON.stringify(JSON.parse(String(reply)), null, 2), writable: true };
		}
		throw vscode.FileSystemError.NoPermissions(`A ${value.type === 'other' ? value.name : value.type} key is not text`);
	}
}

export async function openKey(extensionUri: vscode.Uri, target: KeyTarget, type: string, onChanged: () => void = () => undefined): Promise<void> {
	if (['string', JSON_TYPE, 'hash', 'list', 'set', 'zset', 'stream'].includes(type)) {
		RedisKeyEditor.show(extensionUri, target, onChanged);
		return;
	}
	void vscode.window.showInformationMessage(`Columbus: ${type} keys open in the console for now`);
}

export function reviveKey(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, target: KeyTarget, onChanged: () => void): void {
	RedisKeyEditor.revive(extensionUri, panel, target, onChanged);
}

export async function openKeyAsText(target: KeyTarget, type: string): Promise<void> {
	if (type === 'string' || type === JSON_TYPE) {
		const document = await vscode.workspace.openTextDocument(keyUri(target));
		const text = document.getText().trim();
		if (type === JSON_TYPE || /^[[{]/.test(text)) {
			try {
				JSON.parse(text);
				await vscode.languages.setTextDocumentLanguage(document, 'json');
			} catch {
				await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
			}
		}
		await vscode.window.showTextDocument(document, { preview: false });
		return;
	}
	void vscode.window.showInformationMessage('Columbus: only string and JSON keys open as text');
}

class RedisKeyEditor {
	private static readonly open = new Map<string, RedisKeyEditor>();
	private static nextId = 0;
	private readonly panel: vscode.WebviewPanel;
	private readonly id = `redis-${++RedisKeyEditor.nextId}`;
	private data: Collection | undefined;
	private rows: Value[][] = [];
	private expires: number | undefined;
	private readonly timer = setInterval(() => {
		if (this.expires !== undefined && this.panel.visible) {
			void this.panel.webview.postMessage({ type: 'badge', text: this.badgeText() });
		}
	}, 1000);

	static show(extensionUri: vscode.Uri, target: KeyTarget, onChanged: () => void): void {
		const key = JSON.stringify([target.source.id, target.db, target.key, target.bytes ? Buffer.from(target.bytes).toString('hex') : '']);
		const existing = RedisKeyEditor.open.get(key);
		if (existing) {
			existing.panel.reveal();
			return;
		}
		const editor = new RedisKeyEditor(extensionUri, target, onChanged);
		RedisKeyEditor.open.set(key, editor);
		editor.panel.onDidDispose(() => RedisKeyEditor.open.delete(key));
	}

	static revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, target: KeyTarget, onChanged: () => void): void {
		const key = JSON.stringify([target.source.id, target.db, target.key, target.bytes ? Buffer.from(target.bytes).toString('hex') : '']);
		if (RedisKeyEditor.open.has(key)) {
			panel.dispose();
			return;
		}
		const editor = new RedisKeyEditor(extensionUri, target, onChanged, panel);
		RedisKeyEditor.open.set(key, editor);
		editor.panel.onDidDispose(() => RedisKeyEditor.open.delete(key));
	}

	private constructor(extensionUri: vscode.Uri, private readonly target: KeyTarget, private readonly onChanged: () => void, panel?: vscode.WebviewPanel) {
		const out = vscode.Uri.joinPath(extensionUri, 'out');
		this.panel = panel ?? vscode.window.createWebviewPanel('columbus.redisKey', `${target.key} [${target.source.name}]`, vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [out],
		});
		this.panel.title = `${target.key} [${target.source.name}]`;
		this.panel.webview.options = { enableScripts: true, localResourceRoots: [out] };
		this.panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'light', 'table.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'dark', 'table.svg'),
		};
		this.panel.webview.html = gridHtml(this.panel.webview, out);
		const target$ = registerGridTarget(this.id, this.panel.webview);
		const listener = this.panel.webview.onDidReceiveMessage((message: ViewMessage) => void this.receive(message));
		this.panel.onDidDispose(() => {
			clearInterval(this.timer);
			target$.dispose();
			listener.dispose();
		});
	}

	private post(message: HostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private async reload(): Promise<Collection> {
		const value: RedisValue = await this.target.source.driver.value(this.target.db, keyArg(this.target), LIMIT);
		const data = value.type === 'other' && value.name === JSON_TYPE
			? jsonCollection(JSON.stringify(JSON.parse(String(await this.target.source.driver.command(this.target.db, ['JSON.GET', keyArg(this.target)]))), null, 2))
			: collection(value);
		if (!data) {
			throw new Error(value.type === 'none' ? 'The key no longer exists' : `The key is a ${value.type} now`);
		}
		this.data = data;
		this.rows = data.rows;
		this.setTtl(value.type === 'none' ? -1 : value.ttl);
		return data;
	}

	private async receive(message: ViewMessage): Promise<void> {
		try {
			if (message.type === 'ready') {
				const data = await this.reload();
				this.post({
					type: 'init',
					columns: data.columns,
					pageSize: 500,
					readOnly: false,
					flavor: 'postgres',
					table: this.target.key,
					where: '',
					panel: this.id,
					options: { editable: true, transactions: false, ddl: false, filters: false },
					badge: this.badgeText(),
					restore: { kind: 'redisKey', source: this.target.source.id, db: this.target.db, key: this.target.key, ...(this.target.bytes ? { bytes: Buffer.from(this.target.bytes).toString('hex') } : {}) },
				});
				return;
			}
			const reply = await this.handle(message);
			if (reply) {
				this.post(reply);
			}
		} catch (err) {
			if (message.type !== 'ready') {
				this.post({ type: 'failed', requestId: message.requestId, message: (err as Error).message });
			} else {
				void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
			}
		}
	}

	private setTtl(ttl: number): void {
		this.expires = ttl > 0 ? Date.now() + ttl : undefined;
	}

	private badgeText(): string {
		if (this.expires === undefined) {
			return 'TTL: ∞';
		}
		const remaining = this.expires - Date.now();
		return remaining > 0 ? `TTL: ${formatTtl(remaining)}` : 'TTL: expired';
	}

	private async changeTtl(): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: `Time to Live of ${this.target.key}`,
			prompt: 'Seconds until the key expires; leave empty to keep it forever',
			value: this.expires !== undefined ? String(Math.max(0, Math.ceil((this.expires - Date.now()) / 1000))) : '',
			validateInput: text => (!text.trim() || /^\d+$/.test(text.trim()) ? undefined : 'Enter whole seconds'),
		});
		if (value === undefined) {
			return;
		}
		const { source, db } = this.target;
		const key = keyArg(this.target);
		await source.driver.command(db, value.trim() ? ['EXPIRE', key, value.trim()] : ['PERSIST', key]);
		this.setTtl(Number(await source.driver.command(db, ['PTTL', key])));
		void this.panel.webview.postMessage({ type: 'badge', text: this.badgeText() });
		this.onChanged();
	}

	private sorted(orderBy: string): Value[][] {
		const order = parseOrder(orderBy);
		const columns = this.data?.columns ?? [];
		if (!order.length) {
			return this.rows;
		}
		return [...this.rows].sort((a, b) => {
			for (const { column, desc } of order) {
				const index = columns.findIndex(c => c.name === column);
				const left = a[index];
				const right = b[index];
				const compared = typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''));
				if (compared) {
					return desc ? -compared : compared;
				}
			}
			return 0;
		});
	}

	private async handle(message: Exclude<ViewMessage, { type: 'ready' }>): Promise<HostMessage | undefined> {
		const requestId = message.requestId;
		const data = this.data;
		switch (message.type) {
			case 'load': {
				if (message.offset === 0) {
					await this.reload();
					void this.panel.webview.postMessage({ type: 'badge', text: this.badgeText() });
				}
				const rows = this.sorted(message.orderBy);
				return { type: 'rows', requestId, offset: message.offset, rows: rows.slice(message.offset, message.offset + message.limit), more: message.offset + message.limit < rows.length, total: rows.length };
			}
			case 'count':
				return { type: 'counted', requestId, total: data?.total ?? this.rows.length };
			case 'submit':
				if (data) {
					await this.target.source.driver.batch(this.target.db, commandsFor(data.type, keyArg(this.target), message.changes, this.rows, hexColumns(data.columns)));
					this.onChanged();
				}
				return { type: 'submitted', requestId, transaction: false };
			case 'preview': {
				const lines = data ? commandsFor(data.type, keyArg(this.target), message.changes, this.rows, hexColumns(data.columns)).map(commandLine) : [];
				await showSql([this.target.source.name, `db${this.target.db}`, `${this.target.key} changes`], `MULTI\n${lines.join('\n')}\nEXEC\n`, 'columbus-redis');
				return { type: 'done', requestId };
			}
			case 'export':
				await exportRows({
					title: this.target.key,
					columns: (data?.columns ?? []).map(c => c.name),
					table: this.target.key,
					flavor: 'postgres',
					fetch: async (offset, limit) => {
						const rows = this.sorted(message.orderBy);
						return { rows: rows.slice(offset, offset + limit), more: offset + limit < rows.length };
					},
				}, message.format, message.clipboard);
				return { type: 'done', requestId };
			case 'clipboard':
				await vscode.env.clipboard.writeText(message.text);
				return { type: 'done', requestId };
			case 'readClipboard':
				return { type: 'text', requestId, text: await vscode.env.clipboard.readText() };
			case 'confirm': {
				const answer = await vscode.window.showWarningMessage(message.message, { modal: true }, message.action);
				return { type: 'confirmed', requestId, ok: answer === message.action };
			}
			case 'cancel':
				return { type: 'done', requestId };
			case 'badge':
				await this.changeTtl();
				return { type: 'done', requestId };
			default:
				return { type: 'failed', requestId, message: 'Not available for Redis keys' };
		}
	}
}
