import { QUOTES, quoteIdentifier, sqlLiteral } from './format';
import type { Flavor } from './format';
import type { Value } from './protocol';

export type FilterKind = 'equals' | 'notEquals' | 'contains' | 'null' | 'notNull' | 'greater' | 'less';

export function filterCondition(kind: FilterKind, column: string, value: Value, flavor: Flavor): string {
	const name = quoteIdentifier(column, QUOTES[flavor]);
	const literal = (v: Value): string => sqlLiteral(v, flavor);
	switch (kind) {
		case 'equals':
			return value === null ? `${name} IS NULL` : `${name} = ${literal(value)}`;
		case 'notEquals':
			return value === null ? `${name} IS NOT NULL` : `${name} <> ${literal(value)}`;
		case 'contains': {
			const text = value === null ? '' : String(value).replace(/[\\%_]/g, '\\$&');
			return `${flavor === 'postgres' ? `${name}::text` : name} LIKE ${literal(`%${text}%`)}${flavor === 'sqlite' ? " ESCAPE '\\'" : ''}`;
		}
		case 'null':
			return `${name} IS NULL`;
		case 'notNull':
			return `${name} IS NOT NULL`;
		case 'greater':
			return `${name} > ${literal(value)}`;
		case 'less':
			return `${name} < ${literal(value)}`;
	}
}

export function addCondition(where: string, condition: string): string {
	const current = where.trim();
	return current ? `(${current}) AND ${condition}` : condition;
}
