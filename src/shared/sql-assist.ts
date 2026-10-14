import { QUOTES, caseInsensitive, quoteIdentifier } from './format';
import type { Flavor } from './format';
import type { GridColumn } from './protocol';

export type TokenKind = 'space' | 'keyword' | 'column' | 'identifier' | 'function' | 'string' | 'number' | 'operator' | 'comment';

export interface Token {
	kind: TokenKind;
	text: string;
	start: number;
}

export type Clause = 'where' | 'order';

export interface Suggestion {
	label: string;
	insert: string;
	kind: 'column' | 'keyword' | 'function';
	detail: string;
	column?: GridColumn;
	caret?: number;
}

const KEYWORDS = new Set([
	'ALL', 'AND', 'ANY', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST', 'COLLATE', 'DESC', 'DISTINCT', 'DIV', 'ELSE', 'END', 'ESCAPE',
	'EXISTS', 'FALSE', 'FIRST', 'FROM', 'GROUP', 'HAVING', 'ILIKE', 'IN', 'INTERVAL', 'IS', 'LAST', 'LIKE', 'LIMIT', 'MOD', 'NOT',
	'NULL', 'NULLS', 'OFFSET', 'OR', 'ORDER', 'REGEXP', 'RLIKE', 'SELECT', 'SIMILAR', 'SOME', 'THEN', 'TO', 'TRUE', 'UNKNOWN', 'WHEN',
	'WHERE', 'XOR',
]);

const WHERE_WORDS: Record<Flavor, string[]> = {
	postgres: ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'NULL'],
	mysql: ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'REGEXP', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'NULL'],
	sqlite: ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'NULL'],
};

const ORDER_WORDS: Record<Flavor, string[]> = {
	postgres: ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST'],
	mysql: ['ASC', 'DESC'],
	sqlite: ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST'],
};

const FUNCTIONS: Record<Flavor, string[]> = {
	postgres: ['lower', 'upper', 'length', 'coalesce', 'now', 'date_trunc', 'trim'],
	mysql: ['lower', 'upper', 'length', 'coalesce', 'now', 'date', 'trim'],
	sqlite: ['lower', 'upper', 'length', 'coalesce', 'ifnull', 'date', 'datetime', 'trim'],
};

const WORD = /[A-Za-z_][\w$]*/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const SPACE = /\s+/y;
const OPERATOR = /<=|>=|<>|!=|::|\|\||->>|->|[^\s\w$'"`]/y;

function sticky(pattern: RegExp, text: string, start: number): string | undefined {
	pattern.lastIndex = start;
	return pattern.exec(text)?.[0];
}

function quoted(text: string, start: number, quote: string, backslash: boolean): string {
	let i = start + 1;
	while (i < text.length) {
		if (backslash && text[i] === '\\') {
			i += 2;
			continue;
		}
		if (text[i] === quote) {
			if (text[i + 1] === quote) {
				i += 2;
				continue;
			}
			return text.slice(start, i + 1);
		}
		i++;
	}
	return text.slice(start);
}

function sameName(flavor: Flavor, names: readonly string[], name: string): boolean {
	return names.some(n => caseInsensitive(flavor) ? n.toLowerCase() === name.toLowerCase() : n === name);
}

export function tokenize(text: string, flavor: Flavor, columns: readonly string[]): Token[] {
	const tokens: Token[] = [];
	const identifierQuote = QUOTES[flavor];
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		let kind: TokenKind;
		let value: string | undefined;
		if ((value = sticky(SPACE, text, i))) {
			kind = 'space';
		} else if (text.startsWith('--', i) || (flavor === 'mysql' && char === '#')) {
			const end = text.indexOf('\n', i);
			value = text.slice(i, end < 0 ? text.length : end);
			kind = 'comment';
		} else if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i + 2);
			value = text.slice(i, end < 0 ? text.length : end + 2);
			kind = 'comment';
		} else if (char === "'" || (char === '"' && flavor === 'mysql')) {
			value = quoted(text, i, char, flavor === 'mysql');
			kind = 'string';
		} else if (char === identifierQuote || (flavor === 'sqlite' && (char === '`' || char === '['))) {
			if (char === '[') {
				const close = text.indexOf(']', i + 1);
				value = text.slice(i, close < 0 ? text.length : close + 1);
				const name = value.slice(1, value.endsWith(']') ? -1 : undefined);
				tokens.push({ kind: columns.includes(name) ? 'column' : 'identifier', text: value, start: i });
				i += value.length;
				continue;
			}
			value = quoted(text, i, char, false);
			const name = value.slice(1, value.endsWith(char) && value.length > 1 ? -1 : undefined).split(char + char).join(char);
			kind = columns.includes(name) ? 'column' : 'identifier';
		} else if ((value = sticky(NUMBER, text, i))) {
			kind = 'number';
		} else if ((value = sticky(WORD, text, i))) {
			if (KEYWORDS.has(value.toUpperCase())) {
				kind = 'keyword';
			} else if (/^\s*\(/.test(text.slice(i + value.length))) {
				kind = 'function';
			} else {
				const name = flavor === 'postgres' ? value.toLowerCase() : value;
				kind = sameName(flavor, columns, name) || columns.includes(value) ? 'column' : 'identifier';
			}
		} else {
			value = sticky(OPERATOR, text, i) ?? char;
			kind = 'operator';
		}
		tokens.push({ kind, text: value, start: i });
		i += value.length;
	}
	return tokens;
}

export function wordAt(text: string, caret: number, flavor: Flavor): { start: number; prefix: string } | undefined {
	const before = text.slice(0, caret);
	const tokens = tokenize(before, flavor, []);
	const last = tokens[tokens.length - 1];
	if (last && (last.kind === 'string' || last.kind === 'comment')) {
		const closed = last.kind === 'string'
			? last.text.length > 1 && last.text.endsWith(last.text[0])
			: last.text.startsWith('/*') && last.text.endsWith('*/') && last.text.length > 3;
		if (!closed) {
			return undefined;
		}
	}
	const match = /[\w$]*$/.exec(before);
	const prefix = match?.[0] ?? '';
	if (/^\d/.test(prefix)) {
		return undefined;
	}
	return { start: caret - prefix.length, prefix };
}

export function suggest(prefix: string, clause: Clause, flavor: Flavor, columns: readonly GridColumn[]): Suggestion[] {
	const needle = prefix.toLowerCase();
	const rank = (label: string): number => {
		const name = label.toLowerCase();
		if (name.startsWith(needle)) {
			return 0;
		}
		return needle.length > 1 && name.includes(needle) ? 1 : -1;
	};
	const found: [number, number, Suggestion][] = [];
	columns.forEach(column => {
		const score = rank(column.name);
		if (score >= 0) {
			found.push([score, 0, { label: column.name, insert: quoteIdentifier(column.name, QUOTES[flavor]), kind: 'column', detail: column.type, column }]);
		}
	});
	const words = clause === 'where' ? WHERE_WORDS[flavor] : ORDER_WORDS[flavor];
	for (const word of words) {
		const score = rank(word);
		if (score >= 0 && needle) {
			found.push([score, 1, { label: word, insert: word, kind: 'keyword', detail: 'keyword' }]);
		}
	}
	if (clause === 'where' && needle) {
		for (const name of FUNCTIONS[flavor]) {
			const score = rank(name);
			if (score >= 0) {
				found.push([score, 2, { label: `${name}()`, insert: `${name}()`, kind: 'function', detail: 'function', caret: name === 'now' ? 0 : 1 }]);
			}
		}
	}
	return found.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , suggestion]) => suggestion);
}
