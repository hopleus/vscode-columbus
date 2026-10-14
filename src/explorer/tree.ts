import * as vscode from 'vscode';
import { OBJECT_FOLDERS, foreignColumns, primaryColumns, relationKind } from '../catalog';
import type { ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, KeyInfo, ObjectInfo, ObjectType, SchemaInfo, TableInfo, TableRef } from '../catalog';
import { productOf } from '../drivers/connection';
import type { DriverKind } from '../drivers/connection';
import { DriverMissingError } from '../drivers/files';
import type { RedisKey } from '../drivers/redis';
import { formatTtl } from '../redis/values';
import { isRedis } from '../sources';
import type { AnySource, DataSource, RedisSource, Sources } from '../sources';
import type { SchemaFilter } from './schemas';

type Group = 'columns' | 'keys' | 'foreign keys' | 'indexes' | 'checks' | 'triggers';

export type Node =
	| { kind: 'source'; id: string; source: AnySource }
	| { kind: 'redisDb'; id: string; source: RedisSource; db: number; keys: number }
	| { kind: 'redisFolder'; id: string; source: RedisSource; db: number; prefix: string; keys: TreeKey[] }
	| { kind: 'redisKey'; id: string; source: RedisSource; db: number; key: TreeKey; label: string }
	| { kind: 'info'; id: string; message: string }
	| { kind: 'database'; id: string; source: DataSource; database: DatabaseInfo }
	| { kind: 'schema'; id: string; source: DataSource; database: string; schema: SchemaInfo }
	| { kind: 'folder'; id: string; source: DataSource; database: string; schema: string; label: 'tables' | 'views' | 'materialized views' | 'foreign tables'; tables: TableInfo[] }
	| { kind: 'objectGroup'; id: string; source: DataSource; database: string; label: 'Database Objects' | 'Server Objects'; objects: ObjectInfo[] }
	| { kind: 'objectFolder'; id: string; source: DataSource; database: string; label: string; objects: ObjectInfo[] }
	| { kind: 'object'; id: string; source: DataSource; database: string; object: ObjectInfo }
	| { kind: 'table'; id: string; source: DataSource; ref: TableRef; table: TableInfo }
	| { kind: 'group'; id: string; source: DataSource; ref: TableRef; group: Group; table: TableInfo }
	| { kind: 'column'; id: string; source: DataSource; ref: TableRef; column: ColumnInfo; table: TableInfo }
	| { kind: 'key'; id: string; source: DataSource; ref: TableRef; key: KeyInfo }
	| { kind: 'foreignKey'; id: string; source: DataSource; ref: TableRef; foreignKey: ForeignKeyInfo }
	| { kind: 'index'; id: string; source: DataSource; ref: TableRef; index: IndexInfo }
	| { kind: 'error'; id: string; message: string; download?: DriverKind; outdated?: boolean };

type TreeKey = RedisKey & { expires?: number };
type Product = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'redis' | 'valkey' | 'dragonfly';
const KEY_LIMIT = 5000;

type Icon = 'source' | 'redis-key' | `source-${Product}` | `source-${Product}-connected` | 'database' | 'schema' | 'folder' | 'table' | 'view' | 'materializedView' | 'foreignTable' | 'databaseObjects' | 'serverObjects' | ObjectIcon | 'column' | 'columnKey' | 'columnForeign' | 'key' | 'foreignKey' | 'index';

type ObjectIcon = 'function' | 'procedure' | 'aggregate' | 'sequence' | 'type' | 'trigger' | 'check' | 'extension' | 'role' | 'tablespace';

const OBJECT_ICONS: Record<ObjectType, ObjectIcon> = {
	function: 'function', procedure: 'procedure', aggregate: 'aggregate', sequence: 'sequence',
	enum: 'type', composite: 'type', domain: 'type', range: 'type',
	trigger: 'trigger', check: 'check', extension: 'extension', role: 'role', tablespace: 'tablespace',
};

const OBJECT_CONTEXT: Record<ObjectType, string> = {
	function: 'routine', procedure: 'routine', aggregate: 'routine', sequence: 'sequence',
	enum: 'objectType', composite: 'objectType', domain: 'objectType', range: 'objectType',
	trigger: 'trigger', check: 'check', extension: 'extension', role: 'role', tablespace: 'tablespace',
};

const FOLDER_ORDER = ['routines', 'sequences', 'object types', 'extensions', 'roles', 'tablespaces'];

export function databaseOf(node: Node | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	switch (node.kind) {
		case 'database':
			return node.database.name || undefined;
		case 'schema':
		case 'folder':
		case 'objectGroup':
		case 'objectFolder':
		case 'object':
			return node.database || undefined;
		default:
			return 'ref' in node ? node.ref.database || undefined : undefined;
	}
}

function failure(parent: string, err: unknown): Node {
	const missing = err instanceof DriverMissingError ? err : undefined;
	return { kind: 'error', id: `${parent}/error`, message: (err as Error).message, download: missing?.kind, outdated: missing?.outdated };
}

function list(columns: readonly string[]): string {
	return `(${columns.join(', ')})`;
}

export class DatabaseTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this._onDidChange.event;
	private readonly subscriptions: vscode.Disposable[];
	private readonly identifying = new Set<string>();
	private readonly roots = new Map<string, Node>();
	private readonly schemaNames = new Map<string, string>();
	private readonly redisKeys = new Map<string, Promise<{ keys: TreeKey[]; complete: boolean }>>();


	constructor(private readonly sources: Sources, private readonly extensionUri: vscode.Uri, private readonly filter: SchemaFilter) {
		this.subscriptions = [
			sources.onDidChange(() => {
				this.redisKeys.clear();
				this._onDidChange.fire(undefined);
			}),
			sources.onDidChangeConnection(id => this.refreshSource(id)),
			filter.onDidChange(id => {
				for (const key of [...this.redisKeys.keys()].filter(key => key.startsWith(`${id}/`))) {
					this.redisKeys.delete(key);
				}
				this.refreshSource(id);
			}),
		];
	}

	resolveTreeItem(item: vscode.TreeItem, node: Node): vscode.TreeItem {
		if (node.kind === 'redisKey') {
			const remaining = node.key.expires === undefined ? -1 : node.key.expires - Date.now();
			const ttl = node.key.expires === undefined ? 'no expiry' : remaining > 0 ? `expires in ${formatTtl(remaining)}` : 'expired';
			item.tooltip = `${node.key.name}\n${node.key.type}, ${ttl}`;
		}
		return item;
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this._onDidChange.dispose();
	}

	private refreshSource(id: string): void {
		this._onDidChange.fire(this.roots.get(id));
	}

	private async redisDatabases(node: Node, source: RedisSource): Promise<Node[]> {
		try {
			const databases = await source.driver.databases();
			this.identify(source);
			return databases
				.filter(d => d.keys > 0 || d.index === source.database)
				.map(d => ({ kind: 'redisDb', id: `${node.id}/db${d.index}`, source, db: d.index, keys: d.keys }));
		} catch (err) {
			return [failure(node.id, err)];
		}
	}

	private keysOf(source: RedisSource, db: number): Promise<{ keys: TreeKey[]; complete: boolean }> {
		const key = `${source.id}/${db}`;
		let found = this.redisKeys.get(key);
		if (!found) {
			found = source.driver.scan(db, this.filter.pattern(source.id, db) || '*', KEY_LIMIT).then(result => {
				const now = Date.now();
				return { ...result, keys: result.keys.map(k => (k.ttl > 0 ? { ...k, expires: now + k.ttl } : k)) };
			});
			found.catch(() => this.redisKeys.delete(key));
			this.redisKeys.set(key, found);
		}
		return found;
	}

	private async redisDbChildren(node: Extract<Node, { kind: 'redisDb' }>): Promise<Node[]> {
		try {
			const { keys, complete } = await this.keysOf(node.source, node.db);
			const children = this.redisGroup(node.id, node.source, node.db, keys, '');
			if (!complete) {
				children.push({ kind: 'info', id: `${node.id}/more`, message: `The first ${KEY_LIMIT.toLocaleString('en-US')} keys: narrow them with Filter Keys…` });
			}
			return children;
		} catch (err) {
			return [failure(node.id, err)];
		}
	}

	private redisGroup(dbId: string, source: RedisSource, db: number, keys: readonly TreeKey[], prefix: string): Node[] {
		const folders = new Map<string, TreeKey[]>();
		const leaves: Node[] = [];
		for (const key of keys) {
			const rest = key.name.slice(prefix.length);
			const separator = rest.indexOf(':');
			if (separator < 0) {
				leaves.push({ kind: 'redisKey', id: `${dbId}/${key.bytes ? 'b' : 'k'}:${key.name}`, source, db, key, label: rest });
				continue;
			}
			const segment = `${prefix}${rest.slice(0, separator + 1)}`;
			const group = folders.get(segment) ?? [];
			group.push(key);
			folders.set(segment, group);
		}
		const groups: Node[] = [];
		for (const [segment, group] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
			if (group.length === 1) {
				leaves.push({ kind: 'redisKey', id: `${dbId}/${group[0].bytes ? 'b' : 'k'}:${group[0].name}`, source, db, key: group[0], label: group[0].name.slice(prefix.length) });
			} else {
				groups.push({ kind: 'redisFolder', id: `${dbId}/f:${segment}`, source, db, prefix: segment, keys: group });
			}
		}
		return [...groups, ...leaves.sort((a, b) => (a.kind === 'redisKey' && b.kind === 'redisKey' ? a.key.name.localeCompare(b.key.name) : 0))];
	}

	private visibleSchemas(source: DataSource, schemas: readonly SchemaInfo[]): SchemaInfo[] {
		const visible = this.filter.visible(source.id);
		return visible ? schemas.filter(s => visible.has(s.name)) : [...schemas];
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			const roots = this.sources.list().map((source): Node => ({ kind: 'source', id: source.id, source }));
			this.roots.clear();
			for (const root of roots) {
				this.roots.set(root.id, root);
			}
			return roots;
		}
		switch (node.kind) {
			case 'source': {
				const source = node.source;
				if (isRedis(source)) {
					return this.redisDatabases(node, source);
				}
				try {
					const catalog = await this.sources.catalog(source);
					this.identify(source);
					const names = catalog.databases.flatMap(database => database.schemas.map(schema => schema.name)).join('\n') + `\u0000${catalog.databases.map(d => d.name).join('\n')}`;
					if (this.schemaNames.get(source.id) !== names) {
						this.schemaNames.set(source.id, names);
						setTimeout(() => this._onDidChange.fire(node));
					}
					if (catalog.schemasOnly) {
						return catalog.databases.flatMap(database => this.visibleSchemas(source, database.schemas).map(schema => (
							{ kind: 'schema', id: `${node.id}/${schema.name}`, source: source, database: database.name, schema }
						)));
					}
					const databases: Node[] = catalog.databases.map(database => ({ kind: 'database', id: `${node.id}/${database.name}`, source: source, database }));
					if (catalog.server?.length) {
						databases.push({ kind: 'objectGroup', id: `${node.id}/:server`, source, database: '', label: 'Server Objects', objects: catalog.server });
					}
					return databases;
				} catch (err) {
					return [failure(node.id, err)];
				}
			}
			case 'database': {
				const children: Node[] = this.visibleSchemas(node.source, node.database.schemas).map(schema => ({ kind: 'schema', id: `${node.id}/${schema.name}`, source: node.source, database: node.database.name, schema }));
				if (node.database.objects?.length) {
					children.push({ kind: 'objectGroup', id: `${node.id}/:objects`, source: node.source, database: node.database.name, label: 'Database Objects', objects: node.database.objects });
				}
				return children;
			}
			case 'schema': {
				const folders: Node[] = [];
				for (const [label, kind] of [['tables', 'table'], ['views', 'view'], ['materialized views', 'materialized view'], ['foreign tables', 'foreign table']] as const) {
					const tables = node.schema.tables.filter(t => relationKind(t) === kind).sort((a, b) => a.name.localeCompare(b.name));
					if (tables.length) {
						folders.push({ kind: 'folder', id: `${node.id}/${label}`, source: node.source, database: node.database, schema: node.schema.name, label, tables });
					}
				}
				return [...folders, ...this.objectFolders(node.id, node.source, node.database, node.schema.objects ?? [])];
			}
			case 'objectGroup':
				return this.objectFolders(node.id, node.source, node.database, node.objects);
			case 'objectFolder':
				return node.objects.map(object => ({ kind: 'object', id: `${node.id}/${object.signature ?? object.name}`, source: node.source, database: node.database, object }));
			case 'folder':
				return node.tables.map(table => ({
					kind: 'table',
					id: `${node.id}/${table.name}`,
					source: node.source,
					ref: { database: node.database, schema: node.schema, table: table.name },
					table,
				}));
			case 'table': {
				const groups: Node[] = [];
				const sizes: [Group, number][] = [
					['columns', node.table.columns.length],
					['keys', node.table.keys.length],
					['foreign keys', node.table.foreignKeys.length],
					['indexes', node.table.indexes.length],
					['checks', node.table.checks?.length ?? 0],
					['triggers', node.table.triggers?.length ?? 0],
				];
				for (const [group, size] of sizes) {
					if (size) {
						groups.push({ kind: 'group', id: `${node.id}/${group}`, source: node.source, ref: node.ref, group, table: node.table });
					}
				}
				return groups;
			}
			case 'group':
				return this.groupChildren(node);
			case 'redisDb':
				return this.redisDbChildren(node);
			case 'redisFolder':
				return this.redisGroup(node.id.slice(0, node.id.indexOf('/f:')), node.source, node.db, node.keys, node.prefix);
			default:
				return [];
		}
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const item = new vscode.TreeItem(this.label(node), this.collapsible(node));
		item.id = node.id;
		switch (node.kind) {
			case 'source':
				item.iconPath = this.sourceIcon(node.source);
				item.contextValue = `${isRedis(node.source) ? 'redisSource' : 'source'}${node.source.removable ? '.removable' : ''}${this.sources.isConnected(node.source.id) ? '.connected' : ''}${node.source.kind === 'postgres' ? '.databases' : ''}`;
				item.description = this.databaseCount(node.source) ?? this.schemaCount(node.source);
				break;
			case 'database': {
				item.iconPath = this.icon('database');
				item.contextValue = 'database';
				const visible = this.visibleSchemas(node.source, node.database.schemas).length;
				item.description = `${visible} of ${node.database.schemas.length}`;
				break;
			}
			case 'schema':
				item.iconPath = this.icon('schema');
				item.contextValue = 'schema';
				break;
			case 'folder':
				item.iconPath = this.icon('folder');
				item.description = String(node.tables.length);
				break;
			case 'objectGroup':
				item.iconPath = this.icon(node.label === 'Server Objects' ? 'serverObjects' : 'databaseObjects');
				break;
			case 'objectFolder':
				item.iconPath = this.icon('folder');
				item.description = String(node.objects.length);
				break;
			case 'object': {
				const object = node.object;
				item.iconPath = this.icon(OBJECT_ICONS[object.type]);
				item.description = object.detail;
				item.contextValue = OBJECT_CONTEXT[object.type];
				item.tooltip = new vscode.MarkdownString(`**${object.name}** · ${object.type}${object.table ? ` on ${object.table}` : ''}`).appendCodeblock(object.detail ?? '', 'sql');
				item.command = { command: 'columbus.tree.objectDdl', title: 'Generate DDL', arguments: [node] };
				break;
			}
			case 'table':
				item.iconPath = this.icon(node.table.materialized ? 'materializedView' : node.table.foreign ? 'foreignTable' : node.table.kind);
				item.contextValue = node.table.materialized ? 'materializedView' : node.table.kind;
				item.command = { command: 'columbus.openTable', title: 'Open Table', arguments: [node.source.id, node.ref] };
				item.tooltip = this.tableTooltip(node.table);
				break;
			case 'group':
				item.iconPath = this.icon('folder');
				item.description = String(this.groupSize(node));
				break;
			case 'column': {
				const icon = primaryColumns(node.table).has(node.column.name) ? 'columnKey' : foreignColumns(node.table).has(node.column.name) ? 'columnForeign' : 'column';
				item.iconPath = this.icon(icon);
				item.description = node.column.default === undefined ? node.column.type : `${node.column.type} = ${node.column.default}`;
				item.contextValue = 'column';
				item.tooltip = new vscode.MarkdownString().appendCodeblock(
					`${node.column.name} ${node.column.type}${node.column.nullable ? '' : ' NOT NULL'}${node.column.default === undefined ? '' : ` DEFAULT ${node.column.default}`}`,
					'sql'
				);
				break;
			}
			case 'key':
				item.iconPath = this.icon('key');
				item.description = list(node.key.columns);
				item.contextValue = node.key.primary ? 'primaryKey' : 'key';
				break;
			case 'foreignKey':
				item.iconPath = this.icon('foreignKey');
				item.contextValue = 'foreignKey';
				item.description = `${list(node.foreignKey.columns)} → ${node.foreignKey.refTable} ${list(node.foreignKey.refColumns)}`;
				break;
			case 'index':
				item.iconPath = this.icon('index');
				item.contextValue = 'index';
				item.description = node.index.unique ? `${list(node.index.columns)} UNIQUE` : list(node.index.columns);
				break;
			case 'error':
				if (node.download) {
					item.iconPath = new vscode.ThemeIcon(node.outdated ? 'arrow-circle-up' : 'cloud-download', new vscode.ThemeColor('editorWarning.foreground'));
					item.tooltip = `${node.message}. Click to download them from the Columbus release on GitHub.`;
					item.command = { command: 'columbus.downloadDriver', title: 'Download Driver Files', arguments: [node.download] };
				} else {
					item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
					item.tooltip = node.message;
				}
				break;
			case 'info':
				item.iconPath = new vscode.ThemeIcon('info');
				item.tooltip = node.message;
				break;
			case 'redisDb': {
				const pattern = this.filter.pattern(node.source.id, node.db);
				item.iconPath = this.icon('database');
				item.contextValue = 'redisDb';
				item.description = `${node.keys.toLocaleString('en-US')} ${node.keys === 1 ? 'key' : 'keys'}${pattern ? ` · ${pattern}` : ''}`;
				break;
			}
			case 'redisFolder':
				item.iconPath = this.icon('folder');
				item.contextValue = 'redisFolder';
				item.description = String(node.keys.length);
				item.tooltip = `${node.prefix}*`;
				break;
			case 'redisKey': {
				const remaining = node.key.expires === undefined ? -1 : node.key.expires - Date.now();
				const ttl = node.key.expires === undefined ? '' : remaining > 0 ? 'TTL' : 'expired';
				item.iconPath = this.icon('redis-key');
				item.contextValue = 'redisKey';
				item.description = ttl ? `${node.key.type} · ${ttl}` : node.key.type;
				item.command = { command: 'columbus.redis.openKey', title: 'Open', arguments: [node] };
				break;
			}
		}
		return item;
	}

	private tableTooltip(table: TableInfo): vscode.MarkdownString {
		const width = Math.max(...table.columns.map(c => c.name.length), 0);
		const lines = table.columns.map(c => `${c.name.padEnd(width)}  ${c.type}${c.nullable ? '' : ' NOT NULL'}`);
		return new vscode.MarkdownString(`**${table.name}** · ${table.kind}`).appendCodeblock(lines.join('\n'), 'sql');
	}

	private label(node: Node): string {
		switch (node.kind) {
			case 'source': return node.source.name;
			case 'database': return node.database.name;
			case 'schema': return node.schema.name;
			case 'folder': return node.label;
			case 'objectGroup': return node.label;
			case 'objectFolder': return node.label;
			case 'object': return node.object.name;
			case 'table': return node.table.name;
			case 'group': return node.group;
			case 'column': return node.column.name;
			case 'key': return node.key.name;
			case 'foreignKey': return node.foreignKey.name;
			case 'index': return node.index.name;
			case 'error': return node.download ? (node.outdated ? 'Update driver files' : 'Download missing driver files') : node.message;
			case 'info': return node.message;
			case 'redisDb': return `db${node.db}`;
			case 'redisFolder': return node.prefix.slice(node.prefix.slice(0, -1).lastIndexOf(':') + 1, -1);
			case 'redisKey': return node.label;
		}
	}

	private collapsible(node: Node): vscode.TreeItemCollapsibleState {
		switch (node.kind) {
			case 'column':
			case 'key':
			case 'foreignKey':
			case 'index':
			case 'object':
			case 'error':
			case 'info':
			case 'redisKey':
				return vscode.TreeItemCollapsibleState.None;
			default:
				return vscode.TreeItemCollapsibleState.Collapsed;
		}
	}

	private groupChildren(node: Extract<Node, { kind: 'group' }>): Node[] {
		const { table, id, source, ref } = node;
		switch (node.group) {
			case 'columns':
				return table.columns.map(column => ({ kind: 'column', id: `${id}/${column.name}`, source, ref, column, table }));
			case 'keys':
				return table.keys.map(key => ({ kind: 'key', id: `${id}/${key.name}`, source, ref, key }));
			case 'foreign keys':
				return table.foreignKeys.map(foreignKey => ({ kind: 'foreignKey', id: `${id}/${foreignKey.name}`, source, ref, foreignKey }));
			case 'indexes':
				return table.indexes.map(index => ({ kind: 'index', id: `${id}/${index.name}`, source, ref, index }));
			case 'checks':
				return (table.checks ?? []).map(object => ({ kind: 'object', id: `${id}/${object.name}`, source, database: ref.database, object }));
			case 'triggers':
				return (table.triggers ?? []).map(object => ({ kind: 'object', id: `${id}/${object.name}`, source, database: ref.database, object }));
		}
	}

	private objectFolders(parent: string, source: DataSource, database: string, objects: readonly ObjectInfo[]): Node[] {
		const folders = new Map<string, ObjectInfo[]>();
		for (const object of objects) {
			const label = OBJECT_FOLDERS[object.type];
			folders.set(label, [...folders.get(label) ?? [], object]);
		}
		return [...folders]
			.sort(([a], [b]) => FOLDER_ORDER.indexOf(a) - FOLDER_ORDER.indexOf(b))
			.map(([label, list]): Node => ({
				kind: 'objectFolder',
				id: `${parent}/${label}`,
				source,
				database,
				label,
				objects: [...list].sort((a, b) => a.name.localeCompare(b.name)),
			}));
	}

	private groupSize(node: Extract<Node, { kind: 'group' }>): number {
		return this.groupChildren(node).length;
	}

	private identify(source: AnySource): void {
		if (!source.kind || source.product || this.identifying.has(source.id)) {
			return;
		}
		this.identifying.add(source.id);
		source.driver.version().then(version => {
			const product = productOf(version);
			if (product) {
				source.product = product;
				source.remember?.(product);
				this.refreshSource(source.id);
			}
		}, () => this.identifying.delete(source.id));
	}

	private databaseCount(source: AnySource): string | undefined {
		const catalog = !isRedis(source) && this.schemaNames.has(source.id) ? this.sources.loaded(source.id) : undefined;
		return catalog?.available && !catalog.schemasOnly ? `${catalog.databases.length} of ${catalog.available.length}` : undefined;
	}

	private schemaCount(source: AnySource): string | undefined {
		const names = this.schemaNames.get(source.id)?.split('\u0000')[0];
		if (names === undefined) {
			return undefined;
		}
		const all = names ? names.split('\n') : [];
		const visible = this.filter.visible(source.id);
		return `${visible ? all.filter(name => visible.has(name)).length : all.length} of ${all.length}`;
	}

	private sourceIcon(source: AnySource): { light: vscode.Uri; dark: vscode.Uri } {
		if (!source.kind) {
			return this.icon('source');
		}
		const product = source.product ?? source.kind;
		return this.icon(this.sources.isConnected(source.id) ? `source-${product}-connected` : `source-${product}`);
	}

	private icon(name: Icon): { light: vscode.Uri; dark: vscode.Uri } {
		return {
			light: vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'light', `${name}.svg`),
			dark: vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'dark', `${name}.svg`),
		};
	}
}
