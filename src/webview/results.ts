import type { ExecuteResult } from '../drivers/driver';
import type { ExtractorId } from '../shared/extract';
import type { HostPush, ViewMessage } from '../shared/protocol';
import { OUTPUT_TAB, summary } from '../shared/results-protocol';
import type { OutputEntry, ResultState, ResultsHostMessage, ResultsMessage, ResultsViewMessage } from '../shared/results-protocol';
import { DataView } from './data-view';
import type { Reply } from './data-view';
import { icons } from './icons';

interface State {
	extractor?: ExtractorId;
}

declare function acquireVsCodeApi(): {
	postMessage(message: ResultsViewMessage): void;
	getState(): State | undefined;
	setState(state: State): void;
};

type RowsResult = Extract<ExecuteResult, { kind: 'rows' }>;

const vscode = acquireVsCodeApi();
const mac = navigator.userAgent.includes('Mac');
const waiting = new Map<number, (reply: Reply) => void>();
let nextId = 0;
let active: number | undefined;
let shownVersion: number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text;
	return node;
}

function iconButton(svg: string, title: string, className: string, run: () => void): HTMLButtonElement {
	const button = el('button', className);
	button.innerHTML = svg;
	button.title = title;
	button.addEventListener('click', e => {
		e.stopPropagation();
		run();
	});
	return button;
}

const tabs = el('div', 'result-tabs');
const status = el('div', 'results-status');
const output = el('div', 'results-output');
const view = new DataView({
	send: body => new Promise(resolve => {
		const requestId = ++nextId;
		waiting.set(requestId, resolve);
		vscode.postMessage({ type: 'grid', tab: active ?? -1, message: { ...body, requestId } as ViewMessage });
	}),
	extractor: () => vscode.getState()?.extractor,
	saveExtractor: extractor => vscode.setState({ extractor }),
}, { editable: false, transactions: false, ddl: false, filters: false, sql: true, openInTab: true, expressions: true });
document.getElementById('app')?.append(tabs, status, output, view.root);

function setStatus(state: 'idle' | 'running' | 'ok' | 'error', source: string, text: string): void {
	status.hidden = false;
	status.className = `results-status ${state}`;
	status.replaceChildren(el('span', 'results-source', source), el('span', 'results-text', text));
	if (state === 'running') {
		const stop = el('button', 'results-stop', 'Stop');
		stop.title = `Cancel Running Statement (${mac ? '⌘F2' : 'Ctrl+F2'})`;
		stop.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
		status.append(stop);
	}
}

function renderTabs(message: ResultsMessage): void {
	tabs.replaceChildren(...message.tabs.map(tab => {
		const isOutput = tab.id === OUTPUT_TAB;
		const node = el('div', `result-tab ${tab.state}${tab.id === message.active ? ' active' : ''}${tab.pinned ? ' pinned' : ''}${isOutput ? ' output' : ''}`);
		node.title = tab.pinned ? `${tab.title} (pinned)` : tab.title;
		node.append(el('span', 'result-tab-title', tab.title));
		if (!isOutput) {
			node.append(
				iconButton(icons.pin, tab.pinned ? 'Unpin Tab' : 'Pin Tab', 'result-tab-pin', () => vscode.postMessage({ type: 'pin', id: tab.id })),
				iconButton(icons.close, 'Close', 'result-tab-close', () => vscode.postMessage({ type: 'close', id: tab.id }))
			);
			node.addEventListener('auxclick', e => {
				if (e.button === 1) {
					vscode.postMessage({ type: 'close', id: tab.id });
				}
			});
		}
		node.addEventListener('click', () => vscode.postMessage({ type: 'select', id: tab.id }));
		return node;
	}));
	tabs.hidden = !message.tabs.length;
}

function renderOutput(entries: OutputEntry[]): void {
	status.hidden = true;
	view.root.hidden = true;
	output.hidden = false;
	output.replaceChildren(...entries.slice().reverse().map(entry => {
		const row = el('div', entry.failed ? 'output-entry failed' : 'output-entry');
		row.title = entry.sql;
		row.append(
			el('span', 'output-time', entry.time),
			el('span', 'output-source', entry.source),
			el('span', 'output-sql', entry.sql.replace(/\s+/g, ' ')),
			el('span', 'output-text', entry.text)
		);
		return row;
	}));
}

function renderContent(content: ResultState | undefined, title: string): void {
	output.hidden = true;
	view.root.hidden = true;
	if (!content) {
		setStatus('idle', '', `Run a statement in a query console with ${mac ? '⌃↩' : 'Ctrl+Enter'}`);
		return;
	}
	switch (content.type) {
		case 'running':
			setStatus('running', content.source, `Running ${content.sql.split('\n')[0].slice(0, 120)}`);
			return;
		case 'results': {
			const rows = [...content.results].reverse().find((r): r is RowsResult => r.kind === 'rows');
			setStatus('ok', content.source, `${content.results.map(r => summary(r, r === rows && content.more)).join(' · ')} in ${content.elapsed} ms`);
			if (rows) {
				view.setup({
					columns: rows.columns.map(c => ({
						name: c.name,
						type: c.type,
						numeric: c.numeric,
						primary: c.primary ?? false,
						foreign: c.foreign ?? false,
						nullable: true,
						generated: false,
						hasDefault: false,
						references: c.references,
					})),
					readOnly: true,
					flavor: content.flavor,
					table: title,
					pageSize: 500,
					panel: 'results',
					sql: content.sql,
				});
				view.show({ rows: rows.rows, offset: 0, more: content.more, total: content.more ? undefined : rows.rows.length });
				view.root.hidden = false;
			}
			return;
		}
		case 'error':
			setStatus('error', content.source, content.message);
			return;
	}
}

window.addEventListener('message', (event: MessageEvent<ResultsHostMessage | HostPush>) => {
	const message = event.data;
	if (message.type === 'menu') {
		view.run(message.action);
		return;
	}
	if (message.type === 'filter') {
		view.applyFilter(message.where);
		return;
	}
	if (message.type === 'disconnected' || message.type === 'badge') {
		return;
	}
	if (message.type !== 'state') {
		const resolve = waiting.get(message.requestId);
		waiting.delete(message.requestId);
		resolve?.(message);
		return;
	}
	active = message.active;
	renderTabs(message);
	if (message.active === OUTPUT_TAB) {
		shownVersion = undefined;
		renderOutput(message.output);
	} else if (message.version !== shownVersion || !message.content) {
		shownVersion = message.version;
		renderContent(message.content, message.tabs.find(t => t.id === message.active)?.title ?? 'result');
	}
});

renderContent(undefined, '');
vscode.postMessage({ type: 'ready' });
