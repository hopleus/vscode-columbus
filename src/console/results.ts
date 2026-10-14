import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { ExecuteResult } from '../drivers/driver';
import { registerGridTarget } from '../editor/grid-menu';
import { ResultEditor, answerResult } from './result-editor';
import type { Value, ViewMessage } from '../shared/protocol';
import { OUTPUT_TAB } from '../shared/results-protocol';
import type { OutputEntry, ResultState, ResultsMessage, ResultsViewMessage } from '../shared/results-protocol';
import type { Flavor } from '../shared/format';
import type { AnySource } from '../sources';

const OUTPUT_LIMIT = 200;

export interface QueryTab {
	source: AnySource;
	flavor: Flavor;
	session: string;
	database?: string;
	sql: string;
	pageable: boolean;
	cache?: Value[][];
}

export interface ResultQueries {
	page(query: QueryTab, where: string, orderBy: string, offset: number, limit: number): Promise<{ rows: Value[][]; more: boolean }>;
	count(query: QueryTab, where: string): Promise<number>;
	cancel(query: QueryTab): Promise<void>;
	navigate(query: QueryTab, schema: string, table: string, where: string): Promise<void>;
	locate(query: QueryTab): Promise<void>;
	openInConsole(query: QueryTab): Promise<void>;
}

interface Tab {
	id: number;
	title: string;
	pinned: boolean;
	state: ResultState;
	version: number;
	query: QueryTab;
}

interface ConsoleResults {
	tabs: Tab[];
	active: number | undefined;
	output: OutputEntry[];
}

function lastRows(results: ExecuteResult[]): Extract<ExecuteResult, { kind: 'rows' }> | undefined {
	return [...results].reverse().find((r): r is Extract<ExecuteResult, { kind: 'rows' }> => r.kind === 'rows');
}

export class ResultsView implements vscode.WebviewViewProvider {
	static readonly id = 'columbus.results';
	onCancel: (consoleKey: string) => void = () => undefined;
	queries: ResultQueries | undefined;
	private view: vscode.WebviewView | undefined;
	private readonly consoles = new Map<string, ConsoleResults>();
	private shown: string | undefined;
	private nextId = OUTPUT_TAB;
	private version = 0;

	constructor(private readonly extensionUri: vscode.Uri) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const out = vscode.Uri.joinPath(this.extensionUri, 'out');
		view.webview.options = { enableScripts: true, localResourceRoots: [out] };
		view.webview.html = this.html(view.webview, out);
		view.webview.onDidReceiveMessage((message: ResultsViewMessage) => this.receive(message));
		const target = registerGridTarget('results', view.webview);
		view.onDidDispose(() => {
			this.view = undefined;
			target.dispose();
		});
	}

	start(consoleKey: string, title: string, state: ResultState, query: QueryTab, fresh = false): number {
		const results = this.results(consoleKey);
		const current = results.tabs.find(t => t.id === results.active);
		const tab = current && !current.pinned && !fresh ? current : { id: ++this.nextId, title, pinned: false, state, version: 0, query };
		if (tab !== current) {
			results.tabs.push(tab);
		}
		Object.assign(tab, { title, state, query, version: ++this.version });
		results.active = tab.id;
		this.shown = consoleKey;
		this.render();
		void this.reveal();
		return tab.id;
	}

	update(consoleKey: string, id: number, state: ResultState): void {
		const tab = this.consoles.get(consoleKey)?.tabs.find(t => t.id === id);
		if (tab) {
			tab.state = state;
			tab.version = ++this.version;
			if (this.shown === consoleKey) {
				this.render();
			}
		}
	}

	log(consoleKey: string, entry: OutputEntry): void {
		const output = this.results(consoleKey).output;
		output.push(entry);
		output.splice(0, Math.max(0, output.length - OUTPUT_LIMIT));
		if (this.shown === consoleKey) {
			this.render();
		}
	}

	showConsole(consoleKey: string): void {
		if (this.shown !== consoleKey && this.consoles.has(consoleKey)) {
			this.shown = consoleKey;
			this.render();
		}
	}

	replaceUnpinned(consoleKey: string): void {
		const results = this.results(consoleKey);
		results.tabs = results.tabs.filter(t => t.pinned);
		results.active = undefined;
	}

	drop(consoleKey: string): void {
		this.consoles.delete(consoleKey);
		if (this.shown === consoleKey) {
			this.shown = undefined;
			this.render();
		}
	}

	clear(): void {
		if (this.shown) {
			this.consoles.delete(this.shown);
			this.render();
		}
	}

	snapshot(): { tabs: string[]; content: ResultState | undefined } {
		const results = this.shown ? this.consoles.get(this.shown) : undefined;
		return { tabs: results?.tabs.map(t => t.title) ?? [], content: results?.tabs.find(t => t.id === results.active)?.state };
	}

	async pageActive(where: string, orderBy: string, offset: number, limit: number): Promise<{ rows: Value[][]; more: boolean } | undefined> {
		const results = this.shown ? this.consoles.get(this.shown) : undefined;
		const tab = results?.tabs.find(t => t.id === results.active);
		return tab && this.queries?.page(tab.query, where, orderBy, offset, limit);
	}

	private results(consoleKey: string): ConsoleResults {
		let results = this.consoles.get(consoleKey);
		if (!results) {
			results = { tabs: [], active: undefined, output: [] };
			this.consoles.set(consoleKey, results);
		}
		return results;
	}

	private receive(message: ResultsViewMessage): void {
		const results = this.shown ? this.consoles.get(this.shown) : undefined;
		switch (message.type) {
			case 'ready':
				break;
			case 'cancel':
				if (this.shown) {
					this.onCancel(this.shown);
				}
				return;
			case 'grid':
				void this.grid(results?.tabs.find(t => t.id === message.tab), message.message);
				return;
			case 'select':
				if (results) {
					results.active = message.id;
				}
				break;
			case 'pin': {
				const tab = results?.tabs.find(t => t.id === message.id);
				if (tab) {
					tab.pinned = !tab.pinned;
				}
				break;
			}
			case 'close':
				if (results) {
					const index = results.tabs.findIndex(t => t.id === message.id);
					results.tabs = results.tabs.filter(t => t.id !== message.id);
					if (results.active === message.id) {
						results.active = results.tabs[Math.min(index, results.tabs.length - 1)]?.id ?? (results.output.length ? OUTPUT_TAB : undefined);
					}
				}
				break;
		}
		this.render();
	}

	private async grid(tab: Tab | undefined, message: ViewMessage): Promise<void> {
		if (message.type === 'ready') {
			return;
		}
		const rows = tab?.state.type === 'results' ? lastRows(tab.state.results) : undefined;
		const entry = tab && { title: tab.title, query: tab.query, columns: rows?.columns ?? [] };
		await answerResult(answer => void this.view?.webview.postMessage(answer), entry, this.queries, message, opened => ResultEditor.open(this.extensionUri, opened, this.queries));
	}

	private render(): void {
		if (!this.view) {
			return;
		}
		const results = this.shown ? this.consoles.get(this.shown) : undefined;
		const active = results?.tabs.find(t => t.id === results.active);
		const tabs = (results?.tabs ?? []).map(t => ({ id: t.id, title: t.title, pinned: t.pinned, state: t.state.type }));
		const message: ResultsMessage = {
			type: 'state',
			tabs: results?.output.length ? [{ id: OUTPUT_TAB, title: 'Output', pinned: false, state: 'results' }, ...tabs] : tabs,
			active: results?.active,
			version: results?.active === OUTPUT_TAB ? -results.output.length : active?.version ?? 0,
			content: active?.state,
			output: results?.active === OUTPUT_TAB ? results.output : [],
		};
		void this.view.webview.postMessage(message);
	}

	private async reveal(): Promise<void> {
		if (this.view) {
			this.view.show(true);
			return;
		}
		const editor = vscode.window.activeTextEditor;
		await vscode.commands.executeCommand(`${ResultsView.id}.focus`);
		if (editor) {
			await vscode.window.showTextDocument(editor.document, editor.viewColumn);
		}
	}

	private html(webview: vscode.Webview, out: vscode.Uri): string {
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(out, 'results.js'));
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
}
