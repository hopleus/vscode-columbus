import * as vscode from 'vscode';
import type { ResultColumn } from '../drivers/driver';
import { exportRows } from '../editor/export';
import { registerGridTarget } from '../editor/grid-menu';
import { gridHtml } from '../editor/panel';
import type { GridColumn, HostMessage, ViewMessage } from '../shared/protocol';
import type { QueryTab, ResultQueries } from './results';

export interface ResultEntry {
	title: string;
	query: QueryTab;
	columns: ResultColumn[];
}

type Answer = Exclude<HostMessage, { type: 'init' }>;

export function resultGridColumns(columns: readonly ResultColumn[]): GridColumn[] {
	return columns.map(c => ({
		name: c.name,
		type: c.type,
		numeric: c.numeric,
		primary: c.primary ?? false,
		foreign: c.foreign ?? false,
		nullable: true,
		generated: false,
		hasDefault: false,
		references: c.references,
	}));
}

export async function answerResult(
	post: (answer: Answer) => void,
	entry: ResultEntry | undefined,
	queries: ResultQueries | undefined,
	message: Exclude<ViewMessage, { type: 'ready' }>,
	openInTab: (entry: ResultEntry) => void
): Promise<void> {
	const requestId = message.requestId;
	if (!entry || !queries) {
		post({ type: 'failed', requestId, message: 'This result is no longer available' });
		return;
	}
	try {
		switch (message.type) {
			case 'load': {
				const page = await queries.page(entry.query, message.where, message.orderBy, message.offset, message.limit);
				post({ type: 'rows', requestId, offset: message.offset, rows: page.rows, more: page.more, total: undefined });
				return;
			}
			case 'count':
				post({ type: 'counted', requestId, total: await queries.count(entry.query, message.where) });
				return;
			case 'cancel':
				await queries.cancel(entry.query);
				post({ type: 'done', requestId });
				return;
			case 'clipboard':
				await vscode.env.clipboard.writeText(message.text);
				post({ type: 'done', requestId });
				return;
			case 'navigate':
				await queries.navigate(entry.query, message.schema, message.table, message.where);
				post({ type: 'done', requestId });
				return;
			case 'openInTab':
				openInTab(entry);
				post({ type: 'done', requestId });
				return;
			case 'query':
				await (message.action === 'locate' ? queries.locate(entry.query) : queries.openInConsole(entry.query));
				post({ type: 'done', requestId });
				return;
			case 'export': {
				const { where, orderBy } = message;
				await exportRows({
					title: entry.title,
					columns: entry.columns.map(c => c.name),
					table: entry.title,
					flavor: entry.query.flavor,
					fetch: (offset, limit) => queries.page(entry.query, where, orderBy, offset, limit),
				}, message.format, message.clipboard);
				post({ type: 'done', requestId });
				return;
			}
			case 'confirm': {
				const answer = await vscode.window.showWarningMessage(message.message, { modal: true }, message.action);
				post({ type: 'confirmed', requestId, ok: answer === message.action });
				return;
			}
			default:
				post({ type: 'failed', requestId, message: 'Not available for query results' });
		}
	} catch (err) {
		post({ type: 'failed', requestId, message: (err as Error).message });
	}
}

export class ResultEditor {
	private static nextId = 0;

	static open(extensionUri: vscode.Uri, entry: ResultEntry, queries: ResultQueries | undefined): void {
		const id = `result-${++ResultEditor.nextId}`;
		const out = vscode.Uri.joinPath(extensionUri, 'out');
		const panel = vscode.window.createWebviewPanel('columbus.result', `${entry.title} [${entry.query.source.name}]`, vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [out],
		});
		panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'light', 'table.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'dark', 'table.svg'),
		};
		panel.webview.html = gridHtml(panel.webview, out);
		const post = (message: HostMessage): void => void panel.webview.postMessage(message);
		const target = registerGridTarget(id, panel.webview);
		const listener = panel.webview.onDidReceiveMessage((message: ViewMessage) => {
			if (message.type === 'ready') {
				post({
					type: 'init',
					columns: resultGridColumns(entry.columns),
					pageSize: 500,
					readOnly: true,
					flavor: entry.query.flavor,
					table: entry.title,
					where: '',
					panel: id,
					sql: entry.query.sql,
					options: { editable: false, transactions: false, ddl: false, filters: entry.query.pageable, sql: true, openInTab: false },
				});
				return;
			}
			void answerResult(post, entry, queries, message, () => ResultEditor.open(extensionUri, entry, queries));
		});
		panel.onDidDispose(() => {
			target.dispose();
			listener.dispose();
		});
	}
}
