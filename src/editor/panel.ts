import { randomBytes, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { gridColumns } from '../catalog';
import type { TableInfo, TableRef } from '../catalog';
import { DIALECTS, tableName } from '../drivers/sql';
import type { ExtractorId } from '../shared/extract';
import type { HostMessage, HostPush, ViewMessage } from '../shared/protocol';
import type { DataSource, Sources } from '../sources';
import { sqlLanguage } from '../console/language';
import { showSql } from './definitions';
import { exportRows, tableCursor } from './export';
import { registerGridTarget } from './grid-menu';

const PAGE_SIZE = 500;

export function gridHtml(webview: vscode.Webview, out: vscode.Uri): string {
	const nonce = randomBytes(16).toString('base64');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(out, 'webview.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(out, 'webview-style.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

export class DataEditor implements vscode.Disposable {
	private static readonly open = new Map<string, DataEditor>();

	static closeSource(sourceId: string): void {
		for (const editor of [...DataEditor.open.values()]) {
			if (editor.source.id === sourceId) {
				editor.panel.dispose();
			}
		}
	}

	static watch(sources: Sources): vscode.Disposable {
		return sources.onDidChangeConnection(id => {
			if (!sources.isConnected(id)) {
				for (const editor of DataEditor.open.values()) {
					if (editor.source.id === id) {
						editor.disconnected();
					}
				}
			}
		});
	}

	static uncommitted(sourceId: string): string[] {
		return [...DataEditor.open.values()].filter(editor => editor.source.id === sourceId && editor.active).map(editor => editor.panel.title);
	}

	static closeTable(sourceId: string, ref: TableRef): void {
		DataEditor.open.get(JSON.stringify([sourceId, ref.database, ref.schema, ref.table]))?.panel.dispose();
	}

	static reloadTable(sourceId: string, ref: TableRef): void {
		void DataEditor.open.get(JSON.stringify([sourceId, ref.database, ref.schema, ref.table]))?.panel.webview.postMessage({ type: 'menu', action: 'reload' } satisfies HostPush);
	}

	static show(extensionUri: vscode.Uri, source: DataSource, ref: TableRef, table: TableInfo, where = ''): void {
		const key = JSON.stringify([source.id, ref.database, ref.schema, ref.table]);
		const existing = DataEditor.open.get(key);
		if (existing) {
			existing.panel.reveal();
			if (where) {
				void existing.panel.webview.postMessage({ type: 'filter', where });
			}
			return;
		}
		DataEditor.open.set(key, new DataEditor(extensionUri, source, ref, table, where, () => DataEditor.open.delete(key)));
	}

	static revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, source: DataSource, ref: TableRef, table: TableInfo, where: string): void {
		const key = JSON.stringify([source.id, ref.database, ref.schema, ref.table]);
		if (DataEditor.open.has(key)) {
			panel.dispose();
			return;
		}
		DataEditor.open.set(key, new DataEditor(extensionUri, source, ref, table, where, () => DataEditor.open.delete(key), panel));
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly session = randomUUID();
	private manual = false;
	private active = false;

	private constructor(
		extensionUri: vscode.Uri,
		private readonly source: DataSource,
		private readonly ref: TableRef,
		private readonly table: TableInfo,
		private readonly where: string,
		onDispose: () => void,
		panel?: vscode.WebviewPanel
	) {
		const out = vscode.Uri.joinPath(extensionUri, 'out');
		this.panel = panel ?? vscode.window.createWebviewPanel('columbus.dataEditor', `${ref.table} [${source.name}]`, vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [out],
		});
		this.panel.title = `${ref.table} [${source.name}]`;
		this.panel.webview.options = { enableScripts: true, localResourceRoots: [out] };
		const icon = table.materialized ? 'materializedView.svg' : table.kind === 'view' ? 'view.svg' : 'table.svg';
		this.panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'light', icon),
			dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'dark', icon),
		};
		this.panel.webview.html = gridHtml(this.panel.webview, out);
		this.disposables.push(
			registerGridTarget(this.session, this.panel.webview),
			this.panel.webview.onDidReceiveMessage((message: ViewMessage) => this.receive(message)),
			this.panel.onDidDispose(() => {
				onDispose();
				this.dispose();
				if (this.active) {
					void this.source.driver.rollback(this.session).catch(() => undefined);
					void vscode.window.showWarningMessage(`Columbus: uncommitted changes in ${this.panel.title} were rolled back`);
				}
			})
		);
	}

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	private disconnected(): void {
		if (this.active) {
			this.active = false;
			void vscode.window.showWarningMessage(`Columbus: uncommitted changes in ${this.panel.title} were rolled back`);
		}
		void this.panel.webview.postMessage({ type: 'disconnected' } satisfies HostPush);
	}

	private post(message: HostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private get language(): string {
		return sqlLanguage(this.source.driver.flavor, this.source.product);
	}

	private get qualifiedName(): string {
		return tableName(DIALECTS[this.source.driver.flavor], this.ref);
	}

	private get sessionId(): string | undefined {
		return this.manual ? this.session : undefined;
	}

	private async receive(message: ViewMessage): Promise<void> {
		if (message.type === 'ready') {
			this.post({
				type: 'init',
				columns: gridColumns(this.table, this.ref.schema),
				pageSize: PAGE_SIZE,
				readOnly: this.table.kind === 'view',
				flavor: this.source.driver.flavor,
				table: this.qualifiedName,
				where: this.where,
				panel: this.session,
				restore: { kind: 'table', source: this.source.id, ref: this.ref, where: this.where },
			});
			return;
		}
		try {
			const reply = await this.handle(message);
			if (reply) {
				this.post(reply);
			}
		} catch (err) {
			this.post({ type: 'failed', requestId: message.requestId, message: (err as Error).message });
		}
	}

	private async handle(message: Exclude<ViewMessage, { type: 'ready' }>): Promise<HostMessage | undefined> {
		const driver = this.source.driver;
		const requestId = message.requestId;
		switch (message.type) {
			case 'load': {
				const { offset, limit, where, orderBy } = message;
				const { rows, more, total } = await driver.select({ table: this.ref, where, orderBy, offset, limit, session: this.session });
				return { type: 'rows', requestId, offset, rows, more, total };
			}
			case 'count':
				return { type: 'counted', requestId, total: await driver.count(this.ref, message.where, this.session) };
			case 'submit':
				await driver.apply(this.ref, message.changes, this.sessionId);
				this.active = this.manual;
				return { type: 'submitted', requestId, transaction: this.active };
			case 'preview':
				await showSql([this.source.name, this.ref.schema, `${this.ref.table} changes`], await driver.preview(this.ref, message.changes), this.language);
				return { type: 'done', requestId };
			case 'ddl':
				await showSql([this.source.name, this.ref.schema, this.ref.table], await driver.ddl(this.ref), this.language);
				return { type: 'done', requestId };
			case 'export':
				await this.export(message.format, message.where, message.orderBy, message.clipboard);
				return { type: 'done', requestId };
			case 'clipboard':
				await vscode.env.clipboard.writeText(message.text);
				return { type: 'done', requestId };
			case 'readClipboard':
				return { type: 'text', requestId, text: await vscode.env.clipboard.readText() };
			case 'navigate':
				await vscode.commands.executeCommand('columbus.openTable', this.source.id, { database: this.ref.database, schema: message.schema, table: message.table }, message.where);
				return { type: 'done', requestId };
			case 'mode':
				if (!message.manual && this.active) {
					const answer = await vscode.window.showWarningMessage(
						'Commit the transaction before switching to auto-commit?',
						{ modal: true },
						'Commit',
						'Rollback'
					);
					if (!answer) {
						return { type: 'transaction', requestId, manual: true, active: true };
					}
					await (answer === 'Commit' ? driver.commit(this.session) : driver.rollback(this.session));
					this.active = false;
				}
				this.manual = message.manual;
				return { type: 'transaction', requestId, manual: this.manual, active: this.active };
			case 'cancel':
				await driver.cancel(this.session);
				return { type: 'done', requestId };
			case 'commit':
			case 'rollback':
				await (message.type === 'commit' ? driver.commit(this.session) : driver.rollback(this.session));
				this.active = false;
				return { type: 'transaction', requestId, manual: this.manual, active: false };
			case 'confirm': {
				const answer = await vscode.window.showWarningMessage(message.message, { modal: true }, message.action);
				return { type: 'confirmed', requestId, ok: answer === message.action };
			}
		}
	}

	private async export(format: ExtractorId, where: string, orderBy: string, clipboard: boolean): Promise<void> {
		await exportRows({
			title: this.ref.table,
			columns: this.table.columns.map(c => c.name),
			table: this.qualifiedName,
			flavor: this.source.driver.flavor,
			fetch: (offset, limit) => this.source.driver.select({ table: this.ref, where, orderBy, offset, limit, session: this.session }),
			cursor: () => tableCursor(this.source.driver, { table: this.ref, where, orderBy, session: this.session }),
		}, format, clipboard);
	}
}
