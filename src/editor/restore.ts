import * as vscode from 'vscode';
import { reviveKey } from '../redis/keys';
import type { PanelRestore } from '../shared/protocol';
import { isRedis } from '../sources';
import type { Sources } from '../sources';
import { DataEditor } from './panel';

type Revive = (panel: vscode.WebviewPanel, state: unknown) => Promise<void>;

const restoreOf = (state: unknown): PanelRestore | undefined => (state as { restore?: PanelRestore } | undefined)?.restore;

export function registerRestore(extensionUri: vscode.Uri, sources: Sources): { disposables: vscode.Disposable[]; revive(viewType: string, panel: vscode.WebviewPanel, state: unknown): Promise<void> } {
	const revivers: Record<string, Revive> = {
		'columbus.dataEditor': async (panel, state) => {
			const restore = restoreOf(state);
			const source = restore?.kind === 'table' ? sources.sql(restore.source) : undefined;
			if (restore?.kind !== 'table' || !source) {
				panel.dispose();
				return;
			}
			try {
				const table = (await sources.catalog(source)).databases
					.find(d => d.name === restore.ref.database)?.schemas
					.find(s => s.name === restore.ref.schema)?.tables
					.find(t => t.name === restore.ref.table);
				if (table) {
					DataEditor.revive(extensionUri, panel, source, restore.ref, table, restore.where);
					return;
				}
			} catch {
				panel.dispose();
				return;
			}
			panel.dispose();
		},
		'columbus.redisKey': async (panel, state) => {
			const restore = restoreOf(state);
			const source = restore?.kind === 'redisKey' ? sources.get(restore.source) : undefined;
			if (restore?.kind !== 'redisKey' || !source || !isRedis(source)) {
				panel.dispose();
				return;
			}
			const bytes = restore.bytes ? { bytes: Uint8Array.from(Buffer.from(restore.bytes, 'hex')) } : {};
			reviveKey(extensionUri, panel, { source, db: restore.db, key: restore.key, ...bytes }, () => sources.refresh(source.id));
		},
		'columbus.dataSource': async panel => panel.dispose(),
		'columbus.result': async panel => panel.dispose(),
	};
	return {
		disposables: Object.entries(revivers).map(([viewType, revive]) => vscode.window.registerWebviewPanelSerializer(viewType, {
			deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) => revive(panel, state),
		})),
		revive: (viewType, panel, state) => (revivers[viewType] ?? (async (dead: vscode.WebviewPanel) => dead.dispose()))(panel, state),
	};
}
