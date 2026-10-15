import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { relationKind } from '../catalog';
import type { Consoles } from '../console/consoles';
import { DIALECTS, tableName } from '../drivers/sql';
import { exportRows, tableCursor } from '../editor/export';
import type { Definitions } from '../editor/definitions';
import { showSql } from '../editor/definitions';
import { DataEditor } from '../editor/panel';
import { sqlLanguage } from '../console/language';
import { EXTRACTORS } from '../shared/extract';
import type { ExtractorId } from '../shared/extract';
import { isRedis } from '../sources';
import type { DataSource, Sources } from '../sources';
import {
	addColumnSnippet, createIndexSnippet, createTableSnippet, createViewSnippet, deleteSnippet, dropColumn, dropConstraint, dropIndex,
	dropObject, dropTable, insertSnippet, refreshMaterializedView, sqliteRebuild, renameColumn, renameTable, selectSnippet, truncateTable, updateSnippet,
} from './scripts';
import type { SchemaFilter } from './schemas';
import { databaseOf } from './tree';
import type { Node } from './tree';

type TableNode = Extract<Node, { kind: 'table' }>;

const languageOf = (source: DataSource): string => sqlLanguage(source.driver.flavor, source.product);

function pickMany(title: string, placeholder: string, load: () => Promise<vscode.QuickPickItem[]>): Promise<readonly vscode.QuickPickItem[] | undefined> {
	const pick = vscode.window.createQuickPick();
	pick.title = title;
	pick.placeholder = placeholder;
	pick.canSelectMany = true;
	pick.busy = true;
	pick.enabled = false;
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (run: () => void): void => {
			if (!settled) {
				settled = true;
				run();
			}
			pick.dispose();
		};
		pick.onDidAccept(() => settle(() => resolve(pick.selectedItems)));
		pick.onDidHide(() => settle(() => resolve(undefined)));
		pick.show();
		load().then(items => {
			if (!settled) {
				pick.items = items;
				pick.selectedItems = items.filter(item => item.picked);
				pick.busy = false;
				pick.enabled = true;
			}
		}, (err: unknown) => settle(() => reject(err)));
	});
}

export class TreeActions {
	constructor(
		private readonly sources: Sources,
		private readonly consoles: Consoles,
		private readonly selected: () => Node | undefined,
		private readonly filter: SchemaFilter,
		private readonly definitions: Definitions
	) { }

	register(): vscode.Disposable[] {
		const command = (id: string, run: (node: Node) => unknown): vscode.Disposable =>
			vscode.commands.registerCommand(id, async (node?: Node) => {
				const target = node ?? this.selected();
				if (target) {
					try {
						await run(target);
					} catch (err) {
						void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
					}
				}
			});
		const table = (run: (node: TableNode) => unknown) => (node: Node) => node.kind === 'table' ? run(node) : undefined;
		return [
			command('columbus.tree.refresh', node => 'source' in node && this.sources.refresh(node.source.id)),
			command('columbus.tree.chooseSchemas', node => 'source' in node && !isRedis(node.source) && this.chooseSchemas(node.source)),
			command('columbus.tree.chooseDatabases', node => 'source' in node && !isRedis(node.source) && this.chooseDatabases(node.source)),
			command('columbus.tree.disconnect', async node => {
				if (!('source' in node)) {
					return;
				}
				const uncommitted = [...DataEditor.uncommitted(node.source.id), ...this.consoles.uncommitted(node.source.id)];
				if (uncommitted.length) {
					const answer = await vscode.window.showWarningMessage(
						`Disconnect ${node.source.name}?`,
						{ modal: true, detail: `Uncommitted changes in ${uncommitted.join(', ')} will be rolled back.` },
						'Disconnect'
					);
					if (answer !== 'Disconnect') {
						return;
					}
				}
				node.source.driver.disconnect();
			}),
			command('columbus.editData', table(node => vscode.commands.executeCommand('columbus.openTable', node.source.id, node.ref))),
			command('columbus.tree.newConsole', node => 'source' in node && !isRedis(node.source) && this.consoles.open(node.source, databaseOf(node))),
			command('columbus.tree.newTable', node => node.kind === 'schema' && this.consoles.insert(node.source, createTableSnippet(DIALECTS[node.source.driver.flavor], node.schema.name), node.database)),
			command('columbus.tree.newView', node => node.kind === 'schema' && this.consoles.insert(node.source, createViewSnippet(DIALECTS[node.source.driver.flavor], node.schema.name), node.database)),
			command('columbus.tree.newColumn', table(node => this.consoles.insert(node.source, addColumnSnippet(DIALECTS[node.source.driver.flavor], node.ref), node.ref.database))),
			command('columbus.tree.newIndex', table(node => this.consoles.insert(node.source, createIndexSnippet(DIALECTS[node.source.driver.flavor], node.ref), node.ref.database))),
			command('columbus.tree.ddl', table(async node => showSql([node.source.name, node.ref.schema, node.ref.table], await node.source.driver.ddl(node.ref), languageOf(node.source)))),
			command('columbus.tree.select', table(node => this.consoles.insert(node.source, selectSnippet(DIALECTS[node.source.driver.flavor], node.ref, this.columns(node)), node.ref.database))),
			command('columbus.tree.insert', table(node => this.consoles.insert(node.source, insertSnippet(DIALECTS[node.source.driver.flavor], node.ref, this.columns(node)), node.ref.database))),
			command('columbus.tree.update', table(node => this.consoles.insert(node.source, updateSnippet(DIALECTS[node.source.driver.flavor], node.ref, this.columns(node), this.keys(node)), node.ref.database))),
			command('columbus.tree.delete', table(node => this.consoles.insert(node.source, deleteSnippet(DIALECTS[node.source.driver.flavor], node.ref, this.keys(node)), node.ref.database))),
			command('columbus.tree.schemaDdl', node => node.kind === 'schema' && this.schemaDdl(node)),
			command('columbus.tree.objectDdl', async node => {
				if (node.kind === 'object') {
					const { object } = node;
					const name = object.type === 'function' || object.type === 'procedure' || object.type === 'aggregate'
						? `${object.name}${object.signature?.slice(object.signature.indexOf('(')) ?? ''}`
						: object.name;
					await this.definitions.show([node.source.name, object.schema ?? object.type, ...(object.table ? [object.table] : []), name], await node.source.driver.definition(object), languageOf(node.source));
				}
			}),
			command('columbus.tree.copyName', node => vscode.env.clipboard.writeText(this.name(node))),
			command('columbus.tree.copyQualifiedName', node => vscode.env.clipboard.writeText(this.qualifiedName(node))),
			command('columbus.tree.export', table(node => this.export(node))),
			command('columbus.tree.rename', node => this.rename(node)),
			command('columbus.tree.truncate', table(node => this.run(node.source, truncateTable(DIALECTS[node.source.driver.flavor], node.ref), `Truncate table "${node.table.name}"?`, 'Truncate', { refresh: false, database: node.ref.database }))),
			command('columbus.tree.drop', node => this.drop(node)),
			command('columbus.tree.refreshMaterializedView', table(async node => {
				if (node.table.materialized && await this.run(node.source, refreshMaterializedView(DIALECTS[node.source.driver.flavor], node.ref), `Refresh materialized view "${node.table.name}"?`, 'Refresh', { refresh: false, database: node.ref.database })) {
					DataEditor.reloadTable(node.source.id, node.ref);
				}
			})),
		];
	}


	private async chooseDatabases(source: DataSource): Promise<void> {
		const picked = await pickMany(`Databases of ${source.name}`, 'Databases to show in Database Explorer', async () => {
			const catalog = await this.sources.catalog(source);
			const shown = new Set(catalog.databases.map(d => d.name));
			return (catalog.available ?? [...shown]).map(name => ({ label: name, picked: shown.has(name) }));
		});
		if (picked?.length) {
			await this.filter.setDatabases(source.id, picked.map(item => item.label));
			this.sources.refresh(source.id);
		}
	}

	private async chooseSchemas(source: DataSource): Promise<void> {
		let total = 0;
		const picked = await pickMany(`Schemas of ${source.name}`, 'Schemas to show in Database Explorer', async () => {
			const catalog = await this.sources.catalog(source);
			const names = [...new Set(catalog.databases.flatMap(d => d.schemas.map(s => s.name)))].sort((a, b) => a.localeCompare(b));
			const visible = this.filter.visible(source.id);
			total = names.length;
			return names.map(name => ({ label: name, picked: !visible || visible.has(name) }));
		});
		if (picked) {
			await this.filter.set(source.id, picked.length === total ? undefined : picked.map(item => item.label));
		}
	}
	private columns(node: TableNode): { name: string; generated: boolean }[] {
		return node.table.columns.map(c => ({ name: c.name, generated: c.generated ?? false }));
	}

	private keys(node: TableNode): string[] {
		return node.table.keys.find(k => k.primary)?.columns ?? [];
	}

	private name(node: Node): string {
		switch (node.kind) {
			case 'source': return node.source.name;
			case 'database': return node.database.name;
			case 'schema': return node.schema.name;
			case 'table': return node.table.name;
			case 'column': return node.column.name;
			case 'key': return node.key.name;
			case 'foreignKey': return node.foreignKey.name;
			case 'index': return node.index.name;
			case 'object': return node.object.name;
			default: return '';
		}
	}

	private qualifiedName(node: Node): string {
		if (node.kind === 'table') {
			return tableName(DIALECTS[node.source.driver.flavor], node.ref);
		}
		if (node.kind === 'column') {
			const dialect = DIALECTS[node.source.driver.flavor];
			return `${tableName(dialect, node.ref)}.${dialect.quote(node.column.name)}`;
		}
		if (node.kind === 'object' && node.object.schema && !node.object.table) {
			const dialect = DIALECTS[node.source.driver.flavor];
			return `${dialect.quote(node.object.schema)}.${dialect.quote(node.object.name)}`;
		}
		return this.name(node);
	}

	private async schemaDdl(node: Extract<Node, { kind: 'schema' }>): Promise<void> {
		const tables = node.schema.tables;
		const parts = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Columbus: generating DDL of ${node.schema.name}` },
			() => Promise.all(tables.map(table => node.source.driver.ddl({ database: node.database, schema: node.schema.name, table: table.name })))
		);
		await showSql([node.source.name, node.schema.name], parts.join('\n'), languageOf(node.source));
	}

	private async export(node: TableNode): Promise<void> {
		const format = await vscode.window.showQuickPick(
			(Object.keys(EXTRACTORS) as ExtractorId[]).map(id => ({ label: EXTRACTORS[id].label, id })),
			{ title: `Export ${node.table.name}` }
		);
		if (format) {
			await exportRows({
				title: node.table.name,
				columns: node.table.columns.map(c => c.name),
				table: tableName(DIALECTS[node.source.driver.flavor], node.ref),
				flavor: node.source.driver.flavor,
				fetch: (offset, limit) => node.source.driver.select({ table: node.ref, where: '', orderBy: '', offset, limit }),
				cursor: () => tableCursor(node.source.driver, { table: node.ref, where: '', orderBy: '' }),
			}, format.id);
		}
	}

	private async rename(node: Node): Promise<void> {
		if (node.kind !== 'table' && node.kind !== 'column') {
			return;
		}
		const current = this.name(node);
		const name = await vscode.window.showInputBox({
			title: `Rename ${node.kind === 'table' ? relationKind(node.table) : 'column'} "${current}"`,
			value: current,
			valueSelection: [0, current.length],
			validateInput: value => value.trim() ? undefined : 'Enter a name',
		});
		if (!name || name.trim() === current) {
			return;
		}
		const dialect = DIALECTS[node.source.driver.flavor];
		const sql = node.kind === 'table'
			? renameTable(dialect, node.ref, relationKind(node.table), name.trim())
			: renameColumn(dialect, node.ref, current, name.trim());
		if (await this.run(node.source, sql, `Rename "${current}" to "${name.trim()}"?`, 'Rename', { database: node.ref.database }) && node.kind === 'table') {
			DataEditor.closeTable(node.source.id, node.ref);
		}
	}

	private async drop(node: Node): Promise<void> {
		if (node.kind === 'object') {
			await this.run(node.source, dropObject(DIALECTS[node.source.driver.flavor], node.object), `Drop ${node.object.type} "${node.object.name}"?`, 'Drop', { database: node.database });
			return;
		}
		if (!('ref' in node)) {
			return;
		}
		const dialect = DIALECTS[node.source.driver.flavor];
		let sql: string;
		let what: string;
		switch (node.kind) {
			case 'table':
				sql = dropTable(dialect, node.ref, relationKind(node.table));
				what = `${relationKind(node.table)} "${node.table.name}"`;
				break;
			case 'column':
				sql = dropColumn(dialect, node.ref, node.column.name);
				what = `column "${node.column.name}"`;
				break;
			case 'key':
				sql = dialect.flavor === 'sqlite'
					? sqliteRebuild(await node.source.driver.ddl(node.ref), node.ref, { kind: node.key.primary ? 'primaryKey' : 'key', columns: node.key.columns })
					: dropConstraint(dialect, node.ref, node.key.name, node.key.primary ? 'primaryKey' : 'key');
				what = `key "${node.key.name}"`;
				break;
			case 'foreignKey':
				sql = dialect.flavor === 'sqlite'
					? sqliteRebuild(await node.source.driver.ddl(node.ref), node.ref, { kind: 'foreignKey', columns: node.foreignKey.columns })
					: dropConstraint(dialect, node.ref, node.foreignKey.name, 'foreignKey');
				what = `foreign key "${node.foreignKey.name}"`;
				break;
			case 'index':
				sql = dropIndex(dialect, node.ref, node.index.name);
				what = `index "${node.index.name}"`;
				break;
			default:
				return;
		}
		if (await this.run(node.source, sql, `Drop ${what}?`, 'Drop', { database: node.ref.database }) && node.kind === 'table') {
			DataEditor.closeTable(node.source.id, node.ref);
		}
	}

	private async run(source: DataSource, sql: string, question: string, verb: string, options: { refresh?: boolean; database?: string } = {}): Promise<boolean> {
		const { refresh = true, database } = options;
		const answer = await vscode.window.showWarningMessage(question, { modal: true, detail: `${sql};` }, verb, 'Open in Console');
		if (answer === 'Open in Console') {
			await this.consoles.insert(source, `${sql.replace(/[$}\\]/g, '\\$&')};`, database);
			return false;
		}
		if (answer !== verb) {
			return false;
		}
		const session = `tree:${randomUUID()}`;
		try {
			await source.driver.execute(sql, session, database);
		} finally {
			await source.driver.rollback(session).catch(() => undefined);
		}
		if (refresh) {
			this.sources.refresh(source.id);
		}
		return true;
	}
}
