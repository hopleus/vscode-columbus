import * as vscode from 'vscode';
import type { Sources } from '../sources';
import { DRIVERS } from './connection';
import type { DriverKind } from './connection';
import { megabytes } from './files';
import type { DriverFiles, DriverState } from './files';

function describe(state: DriverState): string {
	switch (state.status) {
		case 'ready':
			return `${state.library} ${state.version}`;
		case 'outdated':
			return `needs an update: ${state.library} ${state.previousVersion ?? '?'} → ${state.version} · ${megabytes(state.size)}`;
		default:
			return `not downloaded · ${megabytes(state.size)}`;
	}
}

export function registerDriverCommands(files: DriverFiles, sources: Sources): vscode.Disposable[] {
	const run = async (task: () => Promise<unknown>): Promise<void> => {
		try {
			await task();
		} catch (err) {
			void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
		}
	};
	const pickKind = async (): Promise<DriverKind | undefined> => {
		const states = await Promise.all((Object.keys(DRIVERS) as DriverKind[]).map(kind => files.state(kind)));
		const picked = await vscode.window.showQuickPick(states.map(state => ({
			label: state.label,
			description: describe(state),
			iconPath: new vscode.ThemeIcon(state.status === 'ready' ? 'check' : state.status === 'outdated' ? 'arrow-circle-up' : 'cloud-download'),
			state,
		})), { title: 'Columbus Drivers', placeHolder: 'Choose a driver' });
		return picked?.state.kind;
	};
	return [
		files,
		files.onDidChange(kind => {
			for (const source of sources.list()) {
				if (source.kind === kind || (kind === 'mysql' && source.product === 'mariadb')) {
					sources.refresh(source.id);
				}
			}
		}),
		vscode.commands.registerCommand('columbus.downloadDriver', (kind?: DriverKind) => run(async () => {
			const target = kind ?? await pickKind();
			if (target) {
				await files.download(target);
			}
		})),
		vscode.commands.registerCommand('columbus.manageDrivers', () => run(async () => {
			const kind = await pickKind();
			if (!kind) {
				return;
			}
			const state = await files.state(kind);
			type Action = vscode.QuickPickItem & { run: () => Promise<unknown> };
			const actions: Action[] = [];
			if (state.status !== 'ready') {
				actions.push({ label: state.status === 'outdated' ? '$(arrow-circle-up) Update' : '$(cloud-download) Download', description: megabytes(state.size), run: () => files.download(kind) });
			}
			actions.push({
				label: '$(folder-opened) Install from File…',
				description: `columbus-driver-${DRIVERS[kind].module}.js from the GitHub release`,
				run: async () => {
					const uris = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'Driver files': ['js'] }, title: `Install ${state.label} Driver Files` });
					if (uris?.length) {
						const installed = await files.install(uris);
						void vscode.window.showInformationMessage(`Columbus: installed ${installed.join(', ')}`);
					}
				},
			});
			if (state.status !== 'missing' && !state.local) {
				actions.push({ label: '$(trash) Delete Files', run: () => files.remove(kind) });
			}
			const action = await vscode.window.showQuickPick(actions, { title: `${state.label} · ${describe(state)}` });
			await action?.run();
		})),
	];
}
