import type { TableRef } from '../catalog';
import { sqlLiteral } from '../shared/format';
import type { Flavor } from '../shared/format';
import type { Change, Row, Value } from '../shared/protocol';

export interface Dialect {
	flavor: Flavor;
	quote(name: string): string;
	placeholder(index: number): string;
	insertDefaults(table: string): string;
	looseEquals(column: string, placeholder: string): string;
}

export interface Statement {
	sql: string;
	params: Value[];
	single: boolean;
}

export const postgres: Dialect = {
	flavor: 'postgres',
	quote: name => `"${name.replace(/"/g, '""')}"`,
	placeholder: index => `$${index}`,
	insertDefaults: table => `INSERT INTO ${table} DEFAULT VALUES`,
	looseEquals: (column, placeholder) => `${column}::text = ${placeholder}`,
};

export const mysql: Dialect = {
	flavor: 'mysql',
	quote: name => `\`${name.replace(/`/g, '``')}\``,
	placeholder: () => '?',
	insertDefaults: table => `INSERT INTO ${table} () VALUES ()`,
	looseEquals: (column, placeholder) => `CAST(${column} AS CHAR) COLLATE utf8mb4_bin = ${placeholder}`,
};

export const sqlite: Dialect = {
	flavor: 'sqlite',
	quote: name => `"${name.replace(/"/g, '""')}"`,
	placeholder: () => '?',
	insertDefaults: table => `INSERT INTO ${table} DEFAULT VALUES`,
	looseEquals: (column, placeholder) => `CAST(${column} AS TEXT) = ${placeholder}`,
};

export const DIALECTS: Record<Flavor, Dialect> = { postgres, mysql, sqlite };

export function tableName(dialect: Dialect, ref: TableRef): string {
	return `${dialect.quote(ref.schema)}.${dialect.quote(ref.table)}`;
}

export function statement(dialect: Dialect, table: string, change: Change, exactKey: boolean, inline = false): Statement {
	const params: Value[] = [];
	const bind = (value: Value): string => {
		if (inline) {
			return sqlLiteral(value, dialect.flavor);
		}
		params.push(value);
		return dialect.placeholder(params.length);
	};
	const where = (key: Row): string => Object.entries(key).map(([name, value]) => {
		const column = dialect.quote(name);
		if (value === null) {
			return `${column} IS NULL`;
		}
		return exactKey ? `${column} = ${bind(value)}` : dialect.looseEquals(column, bind(value));
	}).join(' AND ');

	switch (change.kind) {
		case 'update': {
			const set = [
				...Object.entries(change.values).map(([name, value]) => `${dialect.quote(name)} = ${bind(value)}`),
				...Object.entries(change.expressions ?? {}).map(([name, sql]) => `${dialect.quote(name)} = ${sql}`),
			].join(', ');
			return { sql: `UPDATE ${table} SET ${set} WHERE ${where(change.key)}`, params, single: true };
		}
		case 'delete':
			return { sql: `DELETE FROM ${table} WHERE ${where(change.key)}`, params, single: true };
		case 'insert': {
			const expressions = change.expressions ?? {};
			const names = [...Object.keys(change.values), ...Object.keys(expressions)];
			if (!names.length) {
				return { sql: dialect.insertDefaults(table), params, single: false };
			}
			const values = names.map(name => (name in expressions ? expressions[name] : bind(change.values[name])));
			return { sql: `INSERT INTO ${table} (${names.map(dialect.quote).join(', ')}) VALUES (${values.join(', ')})`, params, single: false };
		}
	}
}

export function preview(dialect: Dialect, table: string, changes: readonly Change[], exactKey: boolean): string {
	return changes.map(change => `${statement(dialect, table, change, exactKey, true).sql};\n`).join('');
}

export function parenthesized(text: string): string {
	const trimmed = text.trim();
	let depth = 0;
	for (let i = 0; i < trimmed.length; i++) {
		depth += trimmed[i] === '(' ? 1 : trimmed[i] === ')' ? -1 : 0;
		if (depth === 0 && i < trimmed.length - 1) {
			return `(${trimmed})`;
		}
	}
	return trimmed.startsWith('(') && depth === 0 ? trimmed : `(${trimmed})`;
}

export function selectClauses(where: string, orderBy: string): string {
	const parts: string[] = [];
	if (where.trim()) {
		parts.push(`WHERE ${where.trim()}`);
	}
	if (orderBy.trim()) {
		parts.push(`ORDER BY ${orderBy.trim()}`);
	}
	return parts.join(' ');
}
