import type { GridColumn, Value } from './protocol';

export type Flavor = 'postgres' | 'mysql' | 'sqlite';

export const QUOTES: Record<Flavor, string> = { postgres: '"', mysql: '`', sqlite: '"' };

export function caseInsensitive(flavor: Flavor): boolean {
	return flavor !== 'postgres';
}

export interface SortKey {
	column: string;
	desc: boolean;
}

const PLAIN = /^[A-Za-z_][\w$]*$/;
const PART = /^\s*(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([A-Za-z_][\w$]*))(?:\s+(asc|desc))?\s*$/i;

export function display(value: Value | undefined, column: GridColumn): { text: string; muted: boolean } {
	if (value === undefined) {
		return { text: column.generated ? '<generated>' : column.hasDefault ? '<default>' : '<null>', muted: true };
	}
	if (value === null) {
		return { text: '<null>', muted: true };
	}
	return { text: String(value).replace(/\r?\n/g, '↵'), muted: false };
}

export function quoteIdentifier(name: string, quote: string): string {
	return PLAIN.test(name) ? name : `${quote}${name.split(quote).join(quote + quote)}${quote}`;
}

export function formatOrder(sort: readonly SortKey[], quote: string): string {
	return sort.map(s => s.desc ? `${quoteIdentifier(s.column, quote)} DESC` : quoteIdentifier(s.column, quote)).join(', ');
}

export function parseOrder(text: string): SortKey[] {
	if (!text.trim()) {
		return [];
	}
	const result: SortKey[] = [];
	for (const part of text.split(',')) {
		const match = PART.exec(part);
		if (!match) {
			return [];
		}
		const column = match[1]?.replace(/""/g, '"') ?? match[2]?.replace(/``/g, '`') ?? match[3];
		result.push({ column, desc: match[4]?.toLowerCase() === 'desc' });
	}
	return result;
}

export function sqlLiteral(value: Value, flavor: Flavor): string {
	if (value === null) {
		return 'NULL';
	}
	if (typeof value === 'boolean') {
		return value ? 'TRUE' : 'FALSE';
	}
	if (typeof value === 'number') {
		return String(value);
	}
	const text = flavor === 'mysql' ? value.replace(/\\/g, '\\\\') : value;
	return `'${text.replace(/'/g, "''")}'`;
}
