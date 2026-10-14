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
import { SourceStore } from './store';
import type { StoredSource } from './store';

export function activate(context: vscode.ExtensionContext): void {
	const schemaFilter = new SchemaFilter(context.globalState);
	const sources = new Sources(id => schemaFilter.databases(id));
	const store = new SourceStore(context.globalState, context.secrets);
	const tree = new DatabaseTree(sources, context.extensionUri, schemaFilter);
	const files = new DriverFiles(context);
	const worker = vscode.Uri.joinPath(context.extensionUri, 'out', 'worker.js').fsPath;
	const results = new ResultsView(context.extensionUri);
	const definitions = Definitions.create();
	const view = vscode.window.createTreeView('columbus.explorer', { treeDataProvider: tree, showCollapseAll: true });
	const pickSource = async (node?: Node): Promise<AnySource | undefined> => {
		const selected = node ?? view.selection[0];
		if (selected && 'source' in selected) {
			return selected.source;
		}
		const all = sources.list();
		if (all.length === 1) {
			return all[0];
		}
		return (await vscode.window.showQuickPick(all.map(s => ({ label: s.name, source: s })), { title: 'Choose a Data Source' }))?.source;
	};
	const redisDb = (node: Node | undefined): number | undefined =>
		node && (node.kind === 'redisDb' || node.kind === 'redisFolder' || node.kind === 'redisKey') ? node.db : undefined;
	const assist = new AssistClient(files, vscode.Uri.joinPath(context.extensionUri, 'out', 'assist-worker.js').fsPath);
	const consoles = new Consoles(context.extensionUri, context.globalStorageUri, sources, results, assist, context.globalState, schemaFilter);
	const redisConsoles = new RedisConsoles(context.globalStorageUri, sources, results);

	const dataSource = (stored: StoredSource, config = () => store.config(stored)): AnySource => {
		const base = {
			id: stored.id,
			name: stored.name,
			removable: true,
			product: stored.product,
			remember: (product: StoredSource['product'] & string) => void store.setProduct(stored.id, product),
		};
		const onConnection = (connected: boolean): void => sources.setConnected(stored.id, connected);
		const extras = {
			tunnel: () => files.tunnel(stored.driver),
			trust: async (host: string, fingerprint: string, changed: boolean) => {
				if (!await confirmHost(host, fingerprint, changed)) {
					return false;
				}
				await store.setFingerprint(stored.id, fingerprint);
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
		store,
		files,
		workerPath: worker,
		saved: (stored, created) => {
			if (created) {
				sources.add(dataSource(stored));
			} else {
				DataEditor.closeSource(stored.id);
				sources.replace(dataSource(stored));
			}
		},
	};

	const restore = registerRestore(context.extensionUri, sources);
	context.subscriptions.push(
		sources,
		tree,
		assist,
		consoles,
		...registerGridCommands(),
		...registerDriverCommands(files, sources),
		definitions,
		...new TreeActions(sources, consoles, view, schemaFilter, definitions).register(),
		DataEditor.watch(sources),
		schemaFilter,
		vscode.window.registerWebviewViewProvider(ResultsView.id, results, { webviewOptions: { retainContextWhenHidden: true } }),
		redisConsoles,
		vscode.workspace.registerFileSystemProvider(SCHEME, new RedisStrings(sources), { isCaseSensitive: true }),
		...registerRedisActions(context.extensionUri, sources, schemaFilter, redisConsoles),
		vscode.commands.registerCommand('columbus.openConsole', async (node?: Node) => {
			const source = await pickSource(node);
			if (source && isRedis(source)) {
				await redisConsoles.open(source, redisDb(node ?? view.selection[0]));
			} else if (source) {
				await consoles.open(source, databaseOf(node ?? view.selection[0]));
			}
		}),
		vscode.commands.registerCommand('columbus.chooseConsole', async (node?: Node) => {
			const source = await pickSource(node);
			if (source && isRedis(source)) {
				await redisConsoles.open(source, redisDb(node ?? view.selection[0]));
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
		view,
		vscode.commands.registerCommand('columbus.refresh', () => sources.refresh()),
		vscode.commands.registerCommand('columbus.addDataSource', () => SourceForm.show(forms)),
		vscode.commands.registerCommand('columbus.editDataSource', (node?: Node) => {
			const stored = node?.kind === 'source' ? store.list().find(s => s.id === node.source.id) : undefined;
			if (stored) {
				SourceForm.show(forms, stored);
			}
		}),
		vscode.commands.registerCommand('columbus.removeDataSource', async (node?: Node) => {
			if (node?.kind !== 'source' || !node.source.removable) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(`Remove data source "${node.source.name}"?`, { modal: true }, 'Remove');
			if (answer === 'Remove') {
				DataEditor.closeSource(node.source.id);
				sources.remove(node.source.id);
				await store.remove(node.source.id);
				await schemaFilter.set(node.source.id, undefined);
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
		sources.add({ id: 'demo', name: 'Demo', driver: new DemoDriver(), removable: false });
	}
	if (context.extensionMode === vscode.ExtensionMode.Test) {
		context.subscriptions.push(
			vscode.commands.registerCommand('columbus.test.addSource', (id: string, url: string) => {
				const config = parseUrl(url.startsWith('mysql') ? 'mysql' : /^(redis|valkey)s?:/.test(url) ? 'redis' : /^(sqlite|file):/.test(url) ? 'sqlite' : 'postgres', url);
				const { password, ...rest } = config;
				sources.add(dataSource({ ...rest, id, name: id }, async () => ({ ...rest, password })));
			}),
			vscode.commands.registerCommand('columbus.test.expandSource', async (id: string) => {
				const source = sources.get(id);
				const children = source ? await tree.getChildren({ kind: 'source', id, source }) : [];
				if (source && isRedis(source)) {
					return children.map(child => child.kind === 'redisDb' ? `db${child.db}:${child.keys}` : child.kind);
				}
				const schemas = await Promise.all(children.map(async child => child.kind === 'database' ? await tree.getChildren(child) : [child]));
				return schemas.flat().flatMap(node => node.kind === 'schema' ? [node.schema.name] : []);
			}),
			vscode.commands.registerCommand('columbus.test.sourceItem', async (id: string) => {
				const source = sources.get(id);
				const node: Node | undefined = source && { kind: 'source', id, source };
				const item = node && tree.getTreeItem(node);
				const children = node && source?.kind && !isRedis(source) ? await tree.getChildren(node) : [];
				return item && {
					node,
					icon: (item.iconPath as { dark: vscode.Uri }).dark.path.split('/').pop(),
					description: item.description,
					children: children.map(child => tree.getTreeItem(child).description),
				};
			}),
			vscode.commands.registerCommand('columbus.test.removeSource', (id: string) => sources.remove(id)),
			vscode.commands.registerCommand('columbus.test.restorePanel', (viewType: string, state: unknown) =>
				restore.revive(viewType, vscode.window.createWebviewPanel(viewType, 'Restoring', vscode.ViewColumn.Active, {}), state)),
			vscode.commands.registerCommand('columbus.test.globalStorage', () => context.globalStorageUri.fsPath),
			vscode.commands.registerCommand('columbus.test.showSchemas', (id: string, schemas?: string[]) => schemaFilter.set(id, schemas)),
			vscode.commands.registerCommand('columbus.test.results', () => results.snapshot()),
			vscode.commands.registerCommand('columbus.test.page', (where: string, orderBy: string, offset: number, limit: number) => results.pageActive(where, orderBy, offset, limit))
		);
	}
	for (const stored of store.list()) {
		sources.add(dataSource(stored));
	}
}

export function deactivate(): void { }
