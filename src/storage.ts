import * as path from 'node:path';
import * as vscode from 'vscode';
import { FileState, importLegacy } from './file-state';
import { PROJECT_DIR, withExclude } from './project-state';

export interface Place {
	state: vscode.Memento;
	uri: vscode.Uri;
}

export interface Storage extends Place {
	project: boolean;
}

export class Places {
	constructor(readonly project: Place | undefined, readonly global: Place) { }

	of(global: boolean): Place {
		return global || !this.project ? this.global : this.project;
	}

	all(): Place[] {
		return this.project ? [this.project, this.global] : [this.global];
	}
}

function firstFolder(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

export function resolveStorage(context: vscode.ExtensionContext, folder: string | undefined = firstFolder()): Storage | undefined {
	const mode = vscode.workspace.getConfiguration('columbus').get<string>('storage', 'project');
	if (mode === 'project' && folder) {
		const root = path.join(folder, PROJECT_DIR);
		return { state: new FileState(root, true), uri: vscode.Uri.file(root), project: true };
	}
	if (!vscode.workspace.workspaceFolders?.length || !context.storageUri) {
		return undefined;
	}
	return { state: context.workspaceState, uri: context.storageUri, project: false };
}

export function globalPlace(context: vscode.ExtensionContext): Place & { state: FileState } {
	const state = new FileState(context.globalStorageUri.fsPath);
	importLegacy(context.globalState, state);
	return { state, uri: context.globalStorageUri };
}

export async function syncHidden(project: boolean): Promise<void> {
	const hide = vscode.workspace.getConfiguration('columbus').get<boolean>('hideProjectFolder', true);
	if (hide && !project) {
		return;
	}
	const config = vscode.workspace.getConfiguration('files');
	const next = withExclude(config.inspect<Record<string, boolean>>('exclude')?.globalValue, hide);
	if (next) {
		await config.update('exclude', next, vscode.ConfigurationTarget.Global);
	}
}
