import type { ExtractorId } from '../shared/extract';
import type { HostMessage, HostPush, PanelRestore, ViewMessage } from '../shared/protocol';
import { DataView } from './data-view';
import type { DataViewHost, Reply } from './data-view';

interface State {
	extractor?: ExtractorId;
	restore?: PanelRestore;
}

declare function acquireVsCodeApi(): {
	postMessage(message: ViewMessage): void;
	getState(): State | undefined;
	setState(state: State): void;
};

const vscode = acquireVsCodeApi();
const waiting = new Map<number, (reply: Reply) => void>();
let nextId = 0;

const host: DataViewHost = {
	send: body => new Promise(resolve => {
		const requestId = ++nextId;
		waiting.set(requestId, resolve);
		vscode.postMessage({ ...body, requestId } as ViewMessage);
	}),
	extractor: () => vscode.getState()?.extractor,
	saveExtractor: extractor => vscode.setState({ ...vscode.getState(), extractor }),
};
let view: DataView | undefined;

window.addEventListener('message', (event: MessageEvent<HostMessage | HostPush>) => {
	const data = event.data;
	if (data.type === 'init') {
		if (data.restore) {
			vscode.setState({ ...vscode.getState(), restore: data.restore });
		}
		if (!view) {
			view = new DataView(host, data.options ?? { editable: true, transactions: true, ddl: true, filters: true, expressions: true });
			document.getElementById('app')?.append(view.root);
		}
		view.setup({ columns: data.columns, readOnly: data.readOnly, flavor: data.flavor, table: data.table, pageSize: data.pageSize, panel: data.panel, where: data.where, sql: data.sql, badge: data.badge });
		void view.load(0);
		view.focus();
		return;
	}
	if (!view) {
		return;
	}
	if (data.type === 'filter') {
		view.applyFilter(data.where);
		return;
	}
	if (data.type === 'menu') {
		view.run(data.action);
		return;
	}
	if (data.type === 'disconnected') {
		view.disconnected();
		return;
	}
	if (data.type === 'badge') {
		view.setBadge(data.text);
		return;
	}
	const resolve = waiting.get(data.requestId);
	waiting.delete(data.requestId);
	resolve?.(data);
});

vscode.postMessage({ type: 'ready' });
