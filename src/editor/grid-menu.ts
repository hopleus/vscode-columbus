import * as vscode from 'vscode';

export const GRID_ACTIONS: Record<string, string> = {
	edit: 'edit',
	valueEditor: 'valueEditor',
	setNull: 'setNull',
	setDefault: 'setDefault',
	revert: 'revert',
	copy: 'copy',
	copyCsv: 'copy:csv',
	copyTsv: 'copy:tsv',
	copyJson: 'copy:json',
	copySql: 'copy:sql',
	copyMarkdown: 'copy:markdown',
	paste: 'paste',
	addRow: 'addRow',
	cloneRow: 'cloneRow',
	deleteRows: 'deleteRows',
	filterEquals: 'filter:equals',
	filterNotEquals: 'filter:notEquals',
	filterContains: 'filter:contains',
	filterNull: 'filter:null',
	filterNotNull: 'filter:notNull',
	filterGreater: 'filter:greater',
	filterLess: 'filter:less',
	clearFilter: 'clearFilter',
	goTo: 'goTo',
	recordView: 'recordView',
	aggregate: 'aggregate',
	exportClipboard: 'exportClipboard',
};

const targets = new Map<string, vscode.Webview>();

export function registerGridTarget(panel: string, webview: vscode.Webview): vscode.Disposable {
	targets.set(panel, webview);
	return new vscode.Disposable(() => {
		if (targets.get(panel) === webview) {
			targets.delete(panel);
		}
	});
}

export function registerGridCommands(): vscode.Disposable[] {
	const post = (context: { columbusPanel?: string } | undefined, action: string): void => {
		const webview = context?.columbusPanel ? targets.get(context.columbusPanel) : undefined;
		void webview?.postMessage({ type: 'menu', action });
	};
	return [
		...Object.entries(GRID_ACTIONS).map(([id, action]) =>
			vscode.commands.registerCommand(`columbus.grid.${id}`, (context?: { columbusPanel?: string }) => post(context, action))
		),
		vscode.commands.registerCommand('columbus.grid.setExpression', async (context?: { columbusPanel?: string }) => {
			const sql = await vscode.window.showInputBox({
				title: 'Set SQL Expression',
				prompt: 'The expression is written into the statement as it is, e.g. now(), lower(email) or DEFAULT',
				placeHolder: 'now()',
				validateInput: value => (value.trim() ? undefined : 'Enter an SQL expression'),
			});
			if (sql?.trim()) {
				post(context, `setExpression:${sql.trim()}`);
			}
		}),
	];
}
