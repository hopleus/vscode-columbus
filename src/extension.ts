import * as vscode from 'vscode';
import type { TableRef } from './catalog';
import { AssistClient } from './console/assist-client';
import { Consoles } from './console/consoles';
import { ResultsView } from './console/results';
import { DRIVERS, parseUrl } from './drivers/connection';
import { DemoDriver } from './drivers/demo';
import { DriverFiles } from './drivers/files';
import { registerDriverCommands } from './drivers/manage';
import { RemoteDriver, RemoteRedis } from './drivers/remote';
import { registerGridCommands } from './editor/grid-menu';
import { Definitions } from './editor/definitions';
import { DataEditor } from './editor/panel';
import { registerRestore } from './editor/restore';
import { TreeActions } from './explorer/actions';
import { SchemaFilter } from './explorer/schemas';
import { DatabaseTree } from './explorer/tree';
import { SourceForm, confirmHost, databaseFile } from './forms/source-form';
import type { SourceFormContext } from './forms/source-form';
import { databaseOf } from './explorer/tree';
import type { Node } from './explorer/tree';
import { Sources, isRedis } from './sources';
import type { AnySource } from './sources';
import { registerRedisActions } from './redis/actions';
import { RedisConsoles } from './redis/console';
import { RedisStrings, SCHEME } from './redis/keys';
import { importLegacy } from './file-state';
import { Places, globalPlace, resolveStorage, syncHidden } from './storage';
import { SourceStore } from './store';
import type { StoredSource } from './store';

const SOURCE_MIME = 'application/vnd.columbus.sources';

export function activate(context: vscode.ExtensionContext): void {
	const storage = resolveStorage(context);
	void syncHidden(storage?.project ?? false);
	const global = globalPlace(context);
	const places = new Places(storage, global);
	const globalStore = new SourceStore(global.state, context.secrets);
	const projectStore = storage && new SourceStore(storage.state, context.secrets);
	const storeOf = (global: boolean): SourceStore => (global ? globalStore : projectStore ?? globalStore);
	const isGlobal = (id: string): boolean => sources.get(id)?.global ?? true;
	const storeFor = (id: string): SourceStore => storeOf(isGlobal(id));
	const schemaFilter = new SchemaFilter(id => places.of(isGlobal(id)).state);
	const sources = new Sources(id => schemaFilter.databases(id));
	const projectTree = new DatabaseTree(sources, context.extensionUri, schemaFilter, false);
	const globalTree = new DatabaseTree(sources, context.extensionUri, schemaFilter, true);
	const files = new DriverFiles(context);
	const worker = vscode.Uri.joinPath(context.extensionUri, 'out', 'worker.js').fsPath;
	const results = new ResultsView(context.extensionUri);
	const definitions = Definitions.create();
	const dragAndDrop = (global: boolean): vscode.TreeDragAndDropController<Node> => ({
		dragMimeTypes: [SOURCE_MIME],
		dropMimeTypes: [SOURCE_MIME],
		handleDrag: (nodes, transfer) => {
			const ids = nodes.flatMap(node => (node.kind === 'source' && node.source.removable ? [node.id] : []));
			if (ids.length) {
				transfer.set(SOURCE_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
			}
		},
		handleDrop: async (_target, transfer) => {
			const ids: unknown = JSON.parse(await transfer.get(SOURCE_MIME)?.asString() ?? '[]');
			for (const id of Array.isArray(ids) ? ids : []) {
				if (typeof id === 'string') {
					await moveSource(id, global);
				}
			}
		},
	});
	const controllers = { project: dragAndDrop(false), global: dragAndDrop(true) };
	const views = [
		vscode.window.createTreeView('columbus.project', { treeDataProvider: projectTree, showCollapseAll: true, dragAndDropController: controllers.project }),
		vscode.window.createTreeView('columbus.global', { treeDataProvider: globalTree, showCollapseAll: true, dragAndDropController: controllers.global }),
	];
	let focused = views[0];
	const selected = (): Node | undefined => focused.selection[0];
	const pickSource = async (node?: Node): Promise<AnySource | undefined> => {
		const target = node ?? selected();
		if (target && 'source' in target) {
			return target.source;
		}
		const all = sources.list();
		if (all.length === 1) {
			return all[0];
		}
		return (await vscode.window.showQuickPick(all.map(s => ({ label: s.name, description: s.global && projectStore ? 'global' : undefined, source: s })), { title: 'Choose a Data Source' }))?.source;
	};
	const redisDb = (node: Node | undefined): number | undefined =>
		node && (node.kind === 'redisDb' || node.kind === 'redisFolder' || node.kind === 'redisKey') ? node.db : undefined;
	const assist = new AssistClient(files, vscode.Uri.joinPath(context.extensionUri, 'out', 'assist-worker.js').fsPath);
	const consoles = new Consoles(context.extensionUri, places, sources, results, assist, schemaFilter);
	const redisConsoles = new RedisConsoles(places, sources, results);

	const dataSource = (stored: StoredSource, global: boolean, config = () => storeFor(stored.id).config(stored)): AnySource => {
		const base = {
			id: stored.id,
			name: stored.name,
			removable: true,
			global,
			product: stored.product,
			remember: (product: StoredSource['product'] & string) => void storeFor(stored.id).setProduct(stored.id, product),
		};
		const onConnection = (connected: boolean): void => sources.setConnected(stored.id, connected);
		const extras = {
			tunnel: () => files.tunnel(stored.driver),
			trust: async (host: string, fingerprint: string, changed: boolean) => {
				if (!await confirmHost(host, fingerprint, changed)) {
					return false;
				}
				await storeFor(stored.id).setFingerprint(stored.id, fingerprint);
				return true;
			},
		};
		if (stored.driver === 'sqlite') {
			const fileConfig = config;
			config = async () => ({ ...await fileConfig(), database: databaseFile(stored.database) });
		}
		const flavor = DRIVERS[stored.driver].flavor;
		if (stored.driver === 'redis' || !flavor) {
			return { ...base, kind: 'redis', database: Number.parseInt(stored.database, 10) || 0, driver: new RemoteRedis(worker, () => files.path(stored.driver), config, onConnection, extras) };
		}
		return { ...base, kind: stored.driver, driver: new RemoteDriver(flavor, worker, () => files.path(stored.driver), config, onConnection, extras) };
	};
	const forms: SourceFormContext = {
		extensionUri: context.extensionUri,
		store: storeOf,
		files,
		workerPath: worker,
		saved: (stored, created, global) => {
			if (created) {
				sources.add(dataSource(stored, global));
			} else {
				DataEditor.closeSource(stored.id);
				sources.replace(dataSource(stored, global));
			}
		},
	};

	const removeSource = async (id: string): Promise<void> => {
		if (!await consoles.forgetSource(id)) {
			return;
		}
		DataEditor.closeSource(id);
		await storeFor(id).remove(id);
		await schemaFilter.forget(id);
		sources.remove(id);
	};

	const moveSource = async (id: string, global: boolean): Promise<void> => {
		const source = sources.get(id);
		const from = storeFor(id);
		const to = global ? globalStore : projectStore;
		const stored = from.get(id);
		if (!source || source.global === global || !to || !stored) {
			return;
		}
		const uncommitted = consoles.uncommitted(id);
		if (uncommitted.length) {
			const answer = await vscode.window.showWarningMessage(
				`Move ${source.name} to ${global ? 'Global' : 'Project'}?`,
				{ modal: true, detail: `Its query consoles are closed, and uncommitted changes in ${uncommitted.join(', ')} will be rolled back.` },
				'Move'
			);
			if (answer !== 'Move') {
				return;
			}
		}
		if (!await consoles.moveSource(id, global)) {
			return;
		}
		SourceForm.close(id);
		await to.put(stored);
		await from.detach(id);
		await schemaFilter.move(id, places.of(source.global).state, places.of(global).state);
		sources.setGlobal(id, global);
	};

	const load = (): void => {
		for (const [store, global] of [[projectStore, false], [globalStore, true]] as const) {
			for (const stored of store?.list() ?? []) {
				if (!sources.get(stored.id)) {
					sources.add(dataSource(stored, global));
				}
			}
		}
	};

	const restore = registerRestore(context.extensionUri, sources);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('columbus.hideProjectFolder')) {
				void syncHidden(storage?.project ?? false);
			}
		}),
		sources,
		projectTree,
		globalTree,
		assist,
		...views.map(view => view.onDidChangeSelection(() => {
			focused = view;
		})),
		consoles,
		...registerGridCommands(),
		...registerDriverCommands(files, sources),
		definitions,
		...new TreeActions(sources, consoles, selected, schemaFilter, definitions).register(),
		DataEditor.watch(sources),
		schemaFilter,
		vscode.window.registerWebviewViewProvider(ResultsView.id, results, { webviewOptions: { retainContextWhenHidden: true } }),
		redisConsoles,
		vscode.workspace.registerFileSystemProvider(SCHEME, new RedisStrings(sources), { isCaseSensitive: true }),
		...registerRedisActions(context.extensionUri, sources, schemaFilter, redisConsoles),
		vscode.commands.registerCommand('columbus.openConsole', async (node?: Node) => {
			const source = await pickSource(node);
			if (source && isRedis(source)) {
				await redisConsoles.open(source, redisDb(node ?? selected()));
			} else if (source) {
				await consoles.open(source, databaseOf(node ?? selected()));
			}
		}),
		vscode.commands.registerCommand('columbus.chooseConsole', async (node?: Node) => {
			const source = await pickSource(node);
			if (source && isRedis(source)) {
				await redisConsoles.open(source, redisDb(node ?? selected()));
			} else if (source) {
				await consoles.choose(source);
			}
		}),
		vscode.commands.registerCommand('columbus.execute', () => (redisConsoles.owns() ? redisConsoles.execute() : consoles.execute())),
		vscode.commands.registerCommand('columbus.cancel', () => (redisConsoles.owns() ? redisConsoles.cancel() : consoles.cancel())),
		vscode.commands.registerCommand('columbus.executeAll', () => consoles.executeAll()),
		vscode.commands.registerCommand('columbus.console.commit', () => consoles.finishTransaction('COMMIT')),
		vscode.commands.registerCommand('columbus.console.rollback', () => consoles.finishTransaction('ROLLBACK')),
		vscode.commands.registerCommand('columbus.console.toggleTransactionMode', () => consoles.toggleTransactionMode()),
		vscode.commands.registerCommand('columbus.console.chooseSchema', () => consoles.chooseSchema()),
		vscode.commands.registerCommand('columbus.console.chooseDatabase', () => consoles.chooseDatabase()),
		vscode.commands.registerCommand('columbus.clearResults', () => results.clear()),
		...views,
		vscode.commands.registerCommand('columbus.refresh', () => sources.refresh()),
		vscode.commands.registerCommand('columbus.addDataSource', () => SourceForm.show(forms, !projectStore)),
		vscode.commands.registerCommand('columbus.addProjectDataSource', () => SourceForm.show(forms, !projectStore)),
		vscode.commands.registerCommand('columbus.addGlobalDataSource', () => SourceForm.show(forms, true)),
		vscode.commands.registerCommand('columbus.editDataSource', (node?: Node) => {
			if (node?.kind !== 'source') {
				return;
			}
			const stored = storeFor(node.source.id).get(node.source.id);
			if (stored) {
				SourceForm.show(forms, node.source.global, stored);
			}
		}),
		vscode.commands.registerCommand('columbus.makeGlobal', (node?: Node) => (node?.kind === 'source' ? moveSource(node.id, true) : undefined)),
		vscode.commands.registerCommand('columbus.makeProject', (node?: Node) => (node?.kind === 'source' ? moveSource(node.id, false) : undefined)),
		vscode.commands.registerCommand('columbus.removeDataSource', async (node?: Node) => {
			if (node?.kind !== 'source' || !node.source.removable) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(`Remove data source "${node.source.name}"?`, { modal: true, detail: 'Its query consoles are deleted.' }, 'Remove');
			if (answer === 'Remove') {
				await removeSource(node.source.id);
			}
		}),
		vscode.commands.registerCommand('columbus.openTable', async (sourceId: string, ref: TableRef, where?: string) => {
			const source = sources.sql(sourceId);
			if (!source) {
				return;
			}
			try {
				const catalog = await sources.catalog(source);
				const table = catalog.databases
					.find(d => d.name === ref.database)?.schemas
					.find(s => s.name === ref.schema)?.tables
					.find(t => t.name === ref.table);
				if (table) {
					DataEditor.show(context.extensionUri, source, ref, table, where);
				}
			} catch (err) {
				void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
			}
		}),
		...restore.disposables
	);

	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		sources.add({ id: 'demo', name: 'Demo', driver: new DemoDriver(), removable: false, global: !projectStore });
	}
	if (context.extensionMode === vscode.ExtensionMode.Test) {
		context.subscriptions.push(
			vscode.commands.registerCommand('columbus.test.addSource', (id: string, url: string) => {
				const config = parseUrl(url.startsWith('mysql') ? 'mysql' : /^(redis|valkey)s?:/.test(url) ? 'redis' : /^(sqlite|file):/.test(url) ? 'sqlite' : 'postgres', url);
				const { password, ...rest } = config;
				sources.add(dataSource({ ...rest, id, name: id }, true, async () => ({ ...rest, password })));
			}),
			vscode.commands.registerCommand('columbus.test.expandSource', async (id: string) => {
				const source = sources.get(id);
				const children = source ? await globalTree.getChildren({ kind: 'source', id, source }) : [];
				if (source && isRedis(source)) {
					return children.map(child => child.kind === 'redisDb' ? `db${child.db}:${child.keys}` : child.kind);
				}
				const schemas = await Promise.all(children.map(async child => child.kind === 'database' ? await globalTree.getChildren(child) : [child]));
				return schemas.flat().flatMap(node => node.kind === 'schema' ? [node.schema.name] : []);
			}),
			vscode.commands.registerCommand('columbus.test.sourceItem', async (id: string) => {
				const source = sources.get(id);
				const node: Node | undefined = source && { kind: 'source', id, source };
				const item = node && globalTree.getTreeItem(node);
				const children = node && source?.kind && !isRedis(source) ? await globalTree.getChildren(node) : [];
				return item && {
					node,
					icon: (item.iconPath as { dark: vscode.Uri }).dark.path.split('/').pop(),
					description: item.description,
					children: children.map(child => globalTree.getTreeItem(child).description),
				};
			}),
			vscode.commands.registerCommand('columbus.test.removeSource', (id: string) => sources.remove(id)),
			vscode.commands.registerCommand('columbus.test.restorePanel', (viewType: string, state: unknown) =>
				restore.revive(viewType, vscode.window.createWebviewPanel(viewType, 'Restoring', vscode.ViewColumn.Active, {}), state)),
			vscode.commands.registerCommand('columbus.test.storage', async (folder?: string) => {
				const resolved = resolveStorage(context, folder);
				if (resolved?.project) {
					await resolved.state.update('probe', 1);
				}
				return { project: resolved?.project ?? false, root: resolved?.uri.fsPath };
			}),
			vscode.commands.registerCommand('columbus.test.hideFolder', (project: boolean) => syncHidden(project)),
			vscode.commands.registerCommand('columbus.test.saveSource', async (stored: StoredSource, password: string, global = false) => {
				const level = global || !projectStore;
				await storeOf(level).add(stored, { password });
				forms.saved(stored, true, level);
			}),
			vscode.commands.registerCommand('columbus.test.roots', async (global: boolean) => (await (global ? globalTree : projectTree).getChildren()).map(node => node.id)),
			vscode.commands.registerCommand('columbus.test.move', (id: string, global: boolean) => moveSource(id, global)),
			vscode.commands.registerCommand('columbus.test.dragAndDrop', async (id: string, global: boolean) => {
				const source = sources.get(id);
				const transfer = new vscode.DataTransfer();
				const token = new vscode.CancellationTokenSource().token;
				await (global ? controllers.project : controllers.global).handleDrag?.(source ? [{ kind: 'source', id, source }] : [], transfer, token);
				await (global ? controllers.global : controllers.project).handleDrop?.(undefined, transfer, token);
			}),
			vscode.commands.registerCommand('columbus.test.password', (id: string) => storeFor(id).password(id)),
			vscode.commands.registerCommand('columbus.test.globalState', (key: string) => global.state.get(key)),
			vscode.commands.registerCommand('columbus.test.legacyState', (key: string, value?: unknown) => (value === undefined ? context.globalState.get(key) : context.globalState.update(key, value))),
			vscode.commands.registerCommand('columbus.test.load', () => {
				importLegacy(context.globalState, global.state);
				load();
			}),
			vscode.commands.registerCommand('columbus.test.forgetSource', (id: string) => removeSource(id)),
			vscode.commands.registerCommand('columbus.test.showDatabases', (id: string, databases?: string[]) => schemaFilter.setDatabases(id, databases)),
			vscode.commands.registerCommand('columbus.test.keyPattern', (id: string, db: number, pattern: string) => schemaFilter.setPattern(id, db, pattern)),
			vscode.commands.registerCommand('columbus.test.globalStorage', () => context.globalStorageUri.fsPath),
			vscode.commands.registerCommand('columbus.test.showSchemas', (id: string, schemas?: string[]) => schemaFilter.set(id, schemas)),
			vscode.commands.registerCommand('columbus.test.results', () => results.snapshot()),
			vscode.commands.registerCommand('columbus.test.page', (where: string, orderBy: string, offset: number, limit: number) => results.pageActive(where, orderBy, offset, limit))
		);
	}
	load();
}

export function deactivate(): void { }
