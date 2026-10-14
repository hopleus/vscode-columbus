import type { ObjectInfo, RelationKind, TableRef } from '../catalog';
import { sqlite, tableName } from '../drivers/sql';
import { splitStatements } from '../shared/statements';
import type { Dialect } from '../drivers/sql';

const escape = (text: string): string => text.replace(/[$}\\]/g, '\\$&');

export interface ScriptColumn {
	name: string;
	generated: boolean;
}

function placeholders(dialect: Dialect, columns: readonly ScriptColumn[], start: number, separator: string, assign: boolean): string {
	return columns.map((c, i) => {
		const value = `\${${start + i}:${escape(c.name)}}`;
		return assign ? `${escape(dialect.quote(c.name))} = ${value}` : value;
	}).join(separator);
}

export function selectSnippet(dialect: Dialect, ref: TableRef, columns: readonly ScriptColumn[]): string {
	return `SELECT ${escape(columns.map(c => dialect.quote(c.name)).join(', '))}\nFROM ${escape(tableName(dialect, ref))}\nWHERE \${1:TRUE};`;
}

export function insertSnippet(dialect: Dialect, ref: TableRef, columns: readonly ScriptColumn[]): string {
	const editable = columns.filter(c => !c.generated);
	return `INSERT INTO ${escape(tableName(dialect, ref))} (${escape(editable.map(c => dialect.quote(c.name)).join(', '))})\nVALUES (${placeholders(dialect, editable, 1, ', ', false)});`;
}

export function updateSnippet(dialect: Dialect, ref: TableRef, columns: readonly ScriptColumn[], keys: readonly string[]): string {
	const values = columns.filter(c => !c.generated && !keys.includes(c.name));
	const where = keys.length
		? keys.map((key, i) => `${escape(dialect.quote(key))} = \${${values.length + i + 1}:${escape(key)}}`).join(' AND ')
		: `\${${values.length + 1}:condition}`;
	return `UPDATE ${escape(tableName(dialect, ref))}\nSET ${placeholders(dialect, values, 1, ',\n    ', true)}\nWHERE ${where};`;
}

export function deleteSnippet(dialect: Dialect, ref: TableRef, keys: readonly string[]): string {
	const where = keys.length ? keys.map((key, i) => `${escape(dialect.quote(key))} = \${${i + 1}:${escape(key)}}`).join(' AND ') : '${1:condition}';
	return `DELETE FROM ${escape(tableName(dialect, ref))}\nWHERE ${where};`;
}

export function addColumnSnippet(dialect: Dialect, ref: TableRef): string {
	return `ALTER TABLE ${escape(tableName(dialect, ref))}\n    ADD COLUMN \${1:name} \${2:text};`;
}

export function createIndexSnippet(dialect: Dialect, ref: TableRef): string {
	return `CREATE INDEX \${1:${escape(ref.table)}_idx}\n    ON ${escape(tableName(dialect, ref))} (\${2:column});`;
}

export function createTableSnippet(dialect: Dialect, schema: string): string {
	const ids: Record<Dialect['flavor'], string> = {
		postgres: 'bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
		mysql: 'bigint AUTO_INCREMENT PRIMARY KEY',
		sqlite: 'INTEGER PRIMARY KEY',
	};
	const id = ids[dialect.flavor];
	return `CREATE TABLE ${escape(dialect.quote(schema))}.\${1:table_name}\n(\n    id ${id},\n    $0\n);`;
}

export function createViewSnippet(dialect: Dialect, schema: string): string {
	return `CREATE VIEW ${escape(dialect.quote(schema))}.\${1:view_name} AS\nSELECT $0;`;
}

export function renameTable(dialect: Dialect, ref: TableRef, kind: RelationKind, name: string): string {
	if (dialect.flavor === 'mysql') {
		return `RENAME TABLE ${tableName(dialect, ref)} TO ${tableName(dialect, { ...ref, table: name })}`;
	}
	return `ALTER ${dialect.flavor === 'sqlite' ? 'TABLE' : kind.toUpperCase()} ${tableName(dialect, ref)} RENAME TO ${dialect.quote(name)}`;
}

export function renameColumn(dialect: Dialect, ref: TableRef, from: string, to: string): string {
	return `ALTER TABLE ${tableName(dialect, ref)} RENAME COLUMN ${dialect.quote(from)} TO ${dialect.quote(to)}`;
}

export function dropTable(dialect: Dialect, ref: TableRef, kind: RelationKind): string {
	return `DROP ${kind.toUpperCase()} ${tableName(dialect, ref)}`;
}

export function refreshMaterializedView(dialect: Dialect, ref: TableRef): string {
	return `REFRESH MATERIALIZED VIEW ${tableName(dialect, ref)}`;
}

export function dropObject(dialect: Dialect, object: ObjectInfo): string {
	const name = object.schema ? `${dialect.quote(object.schema)}.${dialect.quote(object.name)}` : dialect.quote(object.name);
	const table = tableName(dialect, { database: '', schema: object.schema ?? '', table: object.table ?? '' });
	switch (object.type) {
		case 'function':
		case 'procedure':
		case 'aggregate':
			return `DROP ${object.type.toUpperCase()} ${dialect.flavor === 'postgres' && object.signature ? object.signature : name}`;
		case 'sequence':
			return `DROP SEQUENCE ${name}`;
		case 'domain':
			return `DROP DOMAIN ${name}`;
		case 'enum':
		case 'composite':
		case 'range':
			return `DROP TYPE ${name}`;
		case 'trigger':
			return dialect.flavor === 'postgres' ? `DROP TRIGGER ${dialect.quote(object.name)} ON ${table}` : `DROP TRIGGER ${name}`;
		case 'check':
			return `ALTER TABLE ${table} DROP CONSTRAINT ${dialect.quote(object.name)}`;
		case 'extension':
			return `DROP EXTENSION ${dialect.quote(object.name)}`;
		case 'role':
			return `DROP ROLE ${dialect.quote(object.name)}`;
		case 'tablespace':
			return `DROP TABLESPACE ${dialect.quote(object.name)}`;
	}
}

export function truncateTable(dialect: Dialect, ref: TableRef): string {
	return dialect.flavor === 'sqlite' ? `DELETE FROM ${tableName(dialect, ref)}` : `TRUNCATE TABLE ${tableName(dialect, ref)}`;
}

export function dropColumn(dialect: Dialect, ref: TableRef, column: string): string {
	return `ALTER TABLE ${tableName(dialect, ref)} DROP COLUMN ${dialect.quote(column)}`;
}

export function dropConstraint(dialect: Dialect, ref: TableRef, name: string, kind: 'primaryKey' | 'key' | 'foreignKey'): string {
	const table = tableName(dialect, ref);
	if (dialect.flavor === 'mysql') {
		if (kind === 'primaryKey') {
			return `ALTER TABLE ${table} DROP PRIMARY KEY`;
		}
		return `ALTER TABLE ${table} DROP ${kind === 'foreignKey' ? 'FOREIGN KEY' : 'INDEX'} ${dialect.quote(name)}`;
	}
	return `ALTER TABLE ${table} DROP CONSTRAINT ${dialect.quote(name)}`;
}

export function dropIndex(dialect: Dialect, ref: TableRef, name: string): string {
	if (dialect.flavor === 'mysql') {
		return `DROP INDEX ${dialect.quote(name)} ON ${tableName(dialect, ref)}`;
	}
	return `DROP INDEX ${dialect.quote(ref.schema)}.${dialect.quote(name)}`;
}

function topLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (char === quote && text[i + 1] === quote && quote !== ']') {
				i++;
			} else if (char === quote) {
				quote = '';
			}
		} else if (char === "'" || char === '"' || char === '`') {
			quote = char;
		} else if (char === '[') {
			quote = ']';
		} else if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth--;
		} else if (char === separator && depth === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts.filter(Boolean);
}

function plainName(text: string): string {
	const trimmed = text.trim();
	return /^["`[]/.test(trimmed) ? trimmed.slice(1, -1).toLowerCase() : trimmed.toLowerCase();
}

function names(list: string): string[] {
	return topLevel(list, ',').map(item => plainName(item.split(/\s+/)[0]));
}

const NAME = String.raw`(?:"(?:[^"]|"")*"|\[[^\]]*\]|` + '`(?:[^`]|``)*`' + String.raw`|[\w$]+)`;
const CONSTRAINT = String.raw`(?:\s+CONSTRAINT\s+${NAME})?`;
const COLUMN_CLAUSES: Record<'primaryKey' | 'key' | 'foreignKey', RegExp> = {
	primaryKey: new RegExp(String.raw`${CONSTRAINT}\s+PRIMARY\s+KEY(?:\s+(?:ASC|DESC))?(?:\s+ON\s+CONFLICT\s+\w+)?(?:\s+AUTOINCREMENT)?`, 'i'),
	key: new RegExp(String.raw`${CONSTRAINT}\s+UNIQUE(?:\s+ON\s+CONFLICT\s+\w+)?`, 'i'),
	foreignKey: new RegExp(String.raw`${CONSTRAINT}\s+REFERENCES\s+${NAME}(?:\s*\([^)]*\))?(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT|NO\s+ACTION)|\s+MATCH\s+\w+|\s+(?:NOT\s+)?DEFERRABLE(?:\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE))?)*`, 'i'),
};
const TABLE_CLAUSES: Record<'primaryKey' | 'key' | 'foreignKey', RegExp> = {
	primaryKey: /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i,
	key: /^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s*\(([^)]*)\)/i,
	foreignKey: /^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)/i,
};

export function sqliteRebuild(ddl: string, ref: TableRef, target: { kind: 'primaryKey' | 'key' | 'foreignKey'; columns: string[] }): string {
	const [create, ...rest] = splitStatements(ddl, 'sqlite').map(part => part.text);
	const open = create.indexOf('(');
	const close = create.lastIndexOf(')');
	if (!/^CREATE\s+TABLE/i.test(create) || open < 0 || close < open) {
		throw new Error(`Could not read the definition of ${ref.table}`);
	}
	const wanted = target.columns.map(column => column.toLowerCase()).join(',');
	let removed = false;
	const items = topLevel(create.slice(open + 1, close), ',').flatMap(item => {
		const table = TABLE_CLAUSES[target.kind].exec(item);
		if (table && !removed && names(table[1]).join(',') === wanted) {
			removed = true;
			return [];
		}
		if (!removed && target.columns.length === 1 && plainName(item.split(/\s+/)[0]) === wanted && COLUMN_CLAUSES[target.kind].test(` ${item}`)) {
			removed = true;
			return [` ${item}`.replace(COLUMN_CLAUSES[target.kind], '').trim()];
		}
		return [item];
	});
	if (!removed) {
		throw new Error(`Could not find the constraint on (${target.columns.join(', ')}) in the definition of ${ref.table}`);
	}
	const copied = items.filter(item => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(item) && !/\b(GENERATED\s+ALWAYS\s+)?AS\s*\(/i.test(item))
		.map(item => sqlite.quote(plainNameKeepCase(item.split(/\s+/)[0])));
	const temporary = { ...ref, table: `columbus_rebuild_${ref.table}` };
	return [
		'PRAGMA foreign_keys = OFF',
		'PRAGMA legacy_alter_table = ON',
		'BEGIN',
		`CREATE TABLE ${tableName(sqlite, temporary)}\n(\n    ${items.join(',\n    ')}\n)${target.kind === 'primaryKey' ? create.slice(close + 1).replace(/\bWITHOUT\s+ROWID\b\s*,?\s*/i, '').replace(/,\s*$/, '') : create.slice(close + 1)}`,
		`INSERT INTO ${tableName(sqlite, temporary)} (${copied.join(', ')}) SELECT ${copied.join(', ')} FROM ${tableName(sqlite, ref)}`,
		`DROP TABLE ${tableName(sqlite, ref)}`,
		`ALTER TABLE ${tableName(sqlite, temporary)} RENAME TO ${sqlite.quote(ref.table)}`,
		...rest.map(part => part.replace(/;$/, '')),
		'COMMIT',
		'PRAGMA legacy_alter_table = OFF',
		'PRAGMA foreign_keys = ON',
	].join(';\n');
}

function plainNameKeepCase(text: string): string {
	const trimmed = text.trim();
	return /^["`[]/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
