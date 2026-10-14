import type { Flavor } from '../shared/format';
import { tokenize } from '../shared/sql-assist';
import { splitStatements } from '../shared/statements';

const READING = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES']);
const WRITING = new Set(['INTO', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);
export const ALIAS = 'columbus_result';

export function pageable(sql: string, flavor: Flavor): boolean {
	if (splitStatements(sql, flavor).length !== 1) {
		return false;
	}
	const words = tokenize(sql, flavor, []).filter(t => t.kind !== 'space' && t.kind !== 'comment' && t.kind !== 'string').map(t => t.text.toUpperCase());
	return READING.has(words[0]) && !words.some(word => WRITING.has(word));
}

function wrapped(sql: string, where: string): string {
	return `SELECT * FROM (\n${sql}\n) AS ${ALIAS}${where.trim() ? ` WHERE ${where.trim()}` : ''}`;
}

export function pageSql(sql: string, where: string, orderBy: string, limit: number, offset: number): string {
	const order = orderBy.trim() ? ` ORDER BY ${orderBy.trim()}` : '';
	return `${wrapped(sql, where)}${order} LIMIT ${Math.max(0, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`;
}

export function countSql(sql: string, where: string): string {
	return `SELECT count(*) AS count FROM (${wrapped(sql, where)}) AS ${ALIAS}_count`;
}

export interface SelectItem {
	qualifier?: string;
	column?: string;
	alias?: string;
	star: boolean;
}

const NOT_ALIAS = new Set(['NULL', 'END', 'TRUE', 'FALSE', 'UNKNOWN', 'ASC', 'DESC']);
const BEFORE_VALUE = new Set(['IS', 'NOT', 'AND', 'OR', 'CASE', 'WHEN', 'THEN', 'ELSE', 'LIKE', 'ILIKE', 'IN', 'BETWEEN', 'SELECT', 'DISTINCT', 'ALL', 'INTERVAL']);

const NAME_KINDS = new Set(['identifier', 'column', 'keyword', 'function']);

function unquote(text: string): string {
	const quote = text[0];
	return (quote === '"' || quote === '`') && text.endsWith(quote) && text.length > 1 ? text.slice(1, -1).split(quote + quote).join(quote) : text;
}

export function selectItems(sql: string, flavor: Flavor): SelectItem[] | undefined {
	const tokens = tokenize(sql, flavor, []).filter(t => t.kind !== 'space' && t.kind !== 'comment');
	let depth = 0;
	let start = -1;
	for (let i = 0; i < tokens.length && start < 0; i++) {
		const text = tokens[i].text;
		depth += text === '(' ? 1 : text === ')' ? -1 : 0;
		if (depth === 0 && tokens[i].kind !== 'string' && text.toUpperCase() === 'SELECT') {
			start = i + 1;
		}
	}
	if (start < 0) {
		return undefined;
	}
	while (start < tokens.length && /^(DISTINCT|ALL)$/i.test(tokens[start].text)) {
		start++;
	}
	const items: (typeof tokens)[] = [[]];
	depth = 0;
	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i];
		if (depth === 0 && token.kind !== 'string' && /^(FROM|INTO|WHERE|GROUP|ORDER|LIMIT|UNION|HAVING|WINDOW)$/i.test(token.text)) {
			break;
		}
		depth += token.text === '(' ? 1 : token.text === ')' ? -1 : 0;
		if (depth === 0 && token.text === ',') {
			items.push([]);
		} else {
			items[items.length - 1].push(token);
		}
	}
	return items.map(item => {
		const as = item.findIndex(t => /^as$/i.test(t.text));
		let expression = as >= 0 ? item.slice(0, as) : item;
		let alias = as >= 0 && item[as + 1] && NAME_KINDS.has(item[as + 1].kind) ? unquote(item[as + 1].text) : undefined;
		const last = expression[expression.length - 1];
		const previous = expression[expression.length - 2];
		const valueBefore = previous && (NAME_KINDS.has(previous.kind) || previous.text === ')' || previous.kind === 'string' || previous.kind === 'number');
		if (as < 0 && last && NAME_KINDS.has(last.kind) && valueBefore && previous.text !== '.' && !NOT_ALIAS.has(last.text.toUpperCase()) && !BEFORE_VALUE.has(previous.text.toUpperCase())) {
			alias = unquote(last.text);
			expression = expression.slice(0, -1);
		}
		const star = expression.length > 0 && expression[expression.length - 1].text === '*' && (expression.length === 1 || expression[expression.length - 2].text === '.');
		const names = expression.filter((_, i) => i % 2 === 0);
		const dots = expression.filter((_, i) => i % 2 === 1);
		if (star || !names.length || names.length > 3 || !names.every(t => NAME_KINDS.has(t.kind)) || !dots.every(t => t.text === '.')) {
			return alias && !star ? { alias, star } : { star };
		}
		const parts = names.map(t => unquote(t.text));
		const column = parts[parts.length - 1];
		return { qualifier: parts.length > 1 ? parts[parts.length - 2] : undefined, column, ...(alias ? { alias } : {}), star: false };
	});
}
