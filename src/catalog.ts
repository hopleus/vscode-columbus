import type { GridColumn } from './shared/protocol';

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	default?: string;
	generated?: boolean;
}

export interface KeyInfo {
	name: string;
	columns: string[];
	primary: boolean;
}

export interface ForeignKeyInfo {
	name: string;
	columns: string[];
	refTable: string;
	refColumns: string[];
}

export interface IndexInfo {
	name: string;
	columns: string[];
	unique: boolean;
}

export type RelationKind = 'table' | 'view' | 'materialized view' | 'foreign table';

export type ObjectType =
	| 'function' | 'procedure' | 'aggregate' | 'sequence' | 'enum' | 'composite' | 'domain' | 'range'
	| 'trigger' | 'check' | 'extension' | 'role' | 'tablespace';

export interface ObjectInfo {
	type: ObjectType;
	name: string;
	database?: string;
	schema?: string;
	table?: string;
	signature?: string;
	detail?: string;
	definition?: string;
}

export const OBJECT_FOLDERS: Record<ObjectType, string> = {
	function: 'routines',
	procedure: 'routines',
	aggregate: 'routines',
	sequence: 'sequences',
	enum: 'object types',
	composite: 'object types',
	domain: 'object types',
	range: 'object types',
	trigger: 'triggers',
	check: 'checks',
	extension: 'extensions',
	role: 'roles',
	tablespace: 'tablespaces',
};

export interface TableInfo {
	name: string;
	kind: 'table' | 'view';
	materialized?: boolean;
	foreign?: boolean;
	columns: ColumnInfo[];
	keys: KeyInfo[];
	foreignKeys: ForeignKeyInfo[];
	indexes: IndexInfo[];
	checks?: ObjectInfo[];
	triggers?: ObjectInfo[];
}

export function relationKind(table: Pick<TableInfo, 'kind' | 'materialized' | 'foreign'>): RelationKind {
	return table.materialized ? 'materialized view' : table.foreign ? 'foreign table' : table.kind;
}

export interface SchemaInfo {
	name: string;
	tables: TableInfo[];
	objects?: ObjectInfo[];
}

export interface DatabaseInfo {
	name: string;
	schemas: SchemaInfo[];
	objects?: ObjectInfo[];
}

export interface Catalog {
	databases: DatabaseInfo[];
	schemasOnly?: boolean;
	current?: string;
	server?: ObjectInfo[];
	available?: string[];
}

export interface TableRef {
	database: string;
	schema: string;
	table: string;
}

const NUMERIC = /^(tiny|small|medium|big)?(int|integer|serial)\b|^(decimal|numeric|float|double|real|bit)\b/i;

export function primaryColumns(table: TableInfo): Set<string> {
	return new Set(table.keys.find(k => k.primary)?.columns ?? []);
}

export function foreignColumns(table: TableInfo): Set<string> {
	return new Set(table.foreignKeys.flatMap(f => f.columns));
}

export function gridColumns(table: TableInfo, schema: string): GridColumn[] {
	const primary = primaryColumns(table);
	const foreign = foreignColumns(table);
	return table.columns.map(c => {
		const column: GridColumn = {
			name: c.name,
			type: c.type,
			primary: primary.has(c.name),
			foreign: foreign.has(c.name),
			numeric: NUMERIC.test(c.type),
			nullable: c.nullable,
			generated: c.generated ?? false,
			hasDefault: c.default !== undefined,
		};
		const key = table.foreignKeys.find(f => f.columns.length === 1 && f.columns[0] === c.name);
		if (key) {
			const dot = key.refTable.indexOf('.');
			column.references = dot < 0
				? { schema, table: key.refTable, column: key.refColumns[0] }
				: { schema: key.refTable.slice(0, dot), table: key.refTable.slice(dot + 1), column: key.refColumns[0] };
		}
		return column;
	});
}
