import type { Catalog, SchemaInfo, TableInfo } from '../catalog';
import { QUOTES, quoteIdentifier } from '../shared/format';
import type { Flavor } from '../shared/format';
import { tokenize } from '../shared/sql-assist';

export interface ConsoleSuggestion {
	label: string;
	insert: string;
	kind: 'table' | 'view' | 'column' | 'schema' | 'keyword' | 'function';
	detail: string;
	sort: string;
	snippet?: boolean;
	retrigger?: boolean;
	owner?: string;
}

const START_WORDS: Record<Flavor, string[]> = {
	postgres: ['SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'EXPLAIN', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SET search_path TO'],
	mysql: ['SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'EXPLAIN', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'USE', 'SHOW TABLES', 'DESCRIBE'],
	sqlite: ['SELECT', 'INSERT INTO', 'INSERT OR REPLACE INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'EXPLAIN QUERY PLAN', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'PRAGMA', 'ATTACH DATABASE', 'VACUUM'],
};
const AFTER_TABLE_WORDS: Record<string, string[]> = {
	FROM: ['WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT', 'UNION'],
	JOIN: ['ON', 'USING', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT'],
	UPDATE: ['SET'],
	INTO: ['VALUES', 'SELECT', 'DEFAULT VALUES'],
	TABLE: ['ADD COLUMN', 'DROP COLUMN', 'ALTER COLUMN', 'RENAME TO'],
};
const EXPRESSION_WORDS = [
	'AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'AS', 'DISTINCT', 'FROM', 'WHERE', 'GROUP BY',
	'ORDER BY', 'HAVING', 'LIMIT', 'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'TRUE', 'FALSE',
];
const FINAL_WORDS = new Set(['IS NULL', 'IS NOT NULL', 'END', 'ASC', 'DESC', 'NULL', 'TRUE', 'FALSE', 'DEFAULT VALUES', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SHOW TABLES']);
const CLAUSES = new Set([
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'BY', 'SET', 'HAVING', 'WHEN', 'THEN', 'ELSE', 'JOIN', 'UPDATE', 'INTO', 'VALUES',
	'LIMIT', 'OFFSET', 'DISTINCT', 'CASE', 'IN', 'IS', 'LIKE', 'BETWEEN', 'EXISTS', 'TABLE', 'USING', 'WITH', 'RETURNING', 'UNION',
]);
const FUNCTIONS: Record<Flavor, [string, string][]> = {
	postgres: [
		['count', 'count(*)'], ['sum', 'sum($1)'], ['avg', 'avg($1)'], ['min', 'min($1)'], ['max', 'max($1)'], ['coalesce', 'coalesce($1, $2)'],
		['lower', 'lower($1)'], ['upper', 'upper($1)'], ['length', 'length($1)'], ['now', 'now()'], ['cast', 'cast($1 AS $2)'],
		['date_trunc', "date_trunc('${1|day,hour,week,month,year|}', $2)"], ['to_char', "to_char($1, '${2:YYYY-MM-DD}')"], ['string_agg', "string_agg($1, '${2:, }')"],
	],
	mysql: [
		['count', 'count(*)'], ['sum', 'sum($1)'], ['avg', 'avg($1)'], ['min', 'min($1)'], ['max', 'max($1)'], ['coalesce', 'coalesce($1, $2)'],
		['lower', 'lower($1)'], ['upper', 'upper($1)'], ['length', 'length($1)'], ['now', 'now()'], ['cast', 'cast($1 AS $2)'],
		['ifnull', 'ifnull($1, $2)'], ['date_format', "date_format($1, '${2:%Y-%m-%d}')"], ['group_concat', 'group_concat($1)'],
	],
	sqlite: [
		['count', 'count(*)'], ['sum', 'sum($1)'], ['avg', 'avg($1)'], ['min', 'min($1)'], ['max', 'max($1)'], ['coalesce', 'coalesce($1, $2)'],
		['lower', 'lower($1)'], ['upper', 'upper($1)'], ['length', 'length($1)'], ['cast', 'cast($1 AS $2)'], ['ifnull', 'ifnull($1, $2)'],
		['substr', 'substr($1, $2)'], ['date', "date('${1:now}')"], ['datetime', "datetime('${1:now}')"], ['strftime', "strftime('${1:%Y-%m-%d}', $2)"],
		['group_concat', 'group_concat($1)'], ['json_extract', "json_extract($1, '${2:\\$}')"],
	],
};
const NOT_ALIASES = new Set(['where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'using', 'set', 'group', 'order', 'limit', 'values', 'select', 'natural', 'as']);
const NAME = '(?:[\\w$]+|"(?:[^"]|"")+"|`(?:[^`]|``)+`)';
const QUALIFIED = `${NAME}(?:\\.${NAME})?`;
const REFERENCE = new RegExp(`\\b(?:from|join|update|into)\\s+(${QUALIFIED})(?:\\s+(?:as\\s+)?([\\w$]+))?`, 'gi');
const FROM_LIST = /\bfrom\s+([^;]*?)(?=\b(?:where|group|order|limit|having|join|left|right|inner|union)\b|$)/gi;
const LIST_ITEM = new RegExp(`^\\s*(${QUALIFIED})(?:\\s+(?:as\\s+)?([\\w$]+))?\\s*$`, 'i');
const QUALIFIER = new RegExp(`(${QUALIFIED})\\.[\\w$]*$`);
const TABLE_CONTEXT = /\b(?:from|join|update|into|table)\s+[\w$"`]*$/i;
const COLUMN_LIST = /\binsert\s+into\s+[\w$."`]+\s*\((?:[^)]*,)?\s*$/i;

function unquote(name: string): string {
	const quote = name[0];
	if ((quote === '"' || quote === '`') && name.endsWith(quote)) {
		return name.slice(1, -1).split(quote + quote).join(quote);
	}
	return name;
}

function parts(reference: string): string[] {
	return (reference.match(new RegExp(NAME, 'g')) ?? []).map(unquote);
}

export function tableReferences(statement: string): Map<string, string[]> {
	const references = new Map<string, string[]>();
	const add = (reference: string, alias: string | undefined): void => {
		const names = parts(reference);
		references.set(names[names.length - 1].toLowerCase(), names);
		if (alias && !NOT_ALIASES.has(alias.toLowerCase())) {
			references.set(alias.toLowerCase(), names);
		}
	};
	for (const match of statement.matchAll(REFERENCE)) {
		add(match[1], match[2]);
	}
	for (const match of statement.matchAll(FROM_LIST)) {
		for (const item of match[1].split(',').slice(1)) {
			const found = LIST_ITEM.exec(item);
			if (found) {
				add(found[1], found[2]);
			}
		}
	}
	return references;
}

function defaultSchemas(catalog: Catalog, flavor: Flavor): Set<string> {
	if (catalog.current) {
		return new Set(flavor === 'postgres' ? [catalog.current, 'public'] : [catalog.current]);
	}
	const schemas = catalog.databases.flatMap(d => d.schemas);
	if (schemas.length === 1) {
		return new Set([schemas[0].name]);
	}
	return new Set(flavor === 'postgres' ? ['public'] : []);
}

function findTable(catalog: Catalog, names: string[], flavor: Flavor): { schema: SchemaInfo; table: TableInfo } | undefined {
	const schemas = catalog.databases.flatMap(d => d.schemas);
	const name = names[names.length - 1];
	const wanted = names.length > 1 ? names[names.length - 2] : undefined;
	const same = (a: string, b: string): boolean => flavor === 'mysql' ? a.toLowerCase() === b.toLowerCase() : a === b || a === b.toLowerCase();
	const ordered = wanted ? schemas.filter(s => same(s.name, wanted)) : [...schemas].sort((a, b) => Number(defaultSchemas(catalog, flavor).has(b.name)) - Number(defaultSchemas(catalog, flavor).has(a.name)));
	for (const schema of ordered) {
		const table = schema.tables.find(t => same(t.name, name));
		if (table) {
			return { schema, table };
		}
	}
	return undefined;
}

function columnsOf(table: TableInfo, flavor: Flavor, owner?: string): ConsoleSuggestion[] {
	return table.columns.map(column => ({
		label: column.name,
		insert: quoteIdentifier(column.name, QUOTES[flavor]),
		kind: 'column',
		detail: owner ? `${owner}.${column.type}` : column.type,
		sort: '0',
	}));
}

function tablesOf(catalog: Catalog, flavor: Flavor, only?: SchemaInfo): ConsoleSuggestion[] {
	const defaults = defaultSchemas(catalog, flavor);
	const quote = QUOTES[flavor];
	const schemas = only ? [only] : catalog.databases.flatMap(d => d.schemas);
	return schemas.flatMap(schema => schema.tables.map((table): ConsoleSuggestion => {
		const qualified = !only && !defaults.has(schema.name);
		const name = quoteIdentifier(table.name, quote);
		return {
			label: qualified ? `${schema.name}.${table.name}` : table.name,
			insert: qualified ? `${quoteIdentifier(schema.name, quote)}.${name}` : name,
			kind: table.kind,
			detail: schema.name,
			sort: '1',
		};
	}));
}

function keywords(words: readonly string[], sort: string): ConsoleSuggestion[] {
	return words.map(word => {
		const final = FINAL_WORDS.has(word);
		return { label: word, insert: final ? word : `${word} `, kind: 'keyword', detail: 'keyword', sort, retrigger: !final };
	});
}

function functions(flavor: Flavor): ConsoleSuggestion[] {
	return FUNCTIONS[flavor].map(([name, snippet]) => ({ label: name, insert: snippet, kind: 'function', detail: 'function', sort: '1', snippet: true }));
}

interface Position {
	context: 'start' | 'afterTable' | 'expression';
	clause: string | undefined;
	afterClause: boolean;
}

function position(before: string, flavor: Flavor): Position {
	const tokens = tokenize(before.replace(/[\w$]*$/, ''), flavor, []).filter(t => t.kind !== 'space' && t.kind !== 'comment');
	if (!tokens.length) {
		return { context: 'start', clause: undefined, afterClause: false };
	}
	let index = tokens.length - 1;
	while (index >= 0 && !(tokens[index].kind !== 'string' && CLAUSES.has(tokens[index].text.toUpperCase()))) {
		index--;
	}
	const clause = index >= 0 ? tokens[index].text.toUpperCase() : undefined;
	const tail = tokens.slice(index + 1);
	const named = tail.length > 0 && tail.every(t => t.kind === 'identifier' || t.kind === 'column' || t.text === '.' || t.text === ',' || /^as$/i.test(t.text));
	return { context: named && clause && clause in AFTER_TABLE_WORDS ? 'afterTable' : 'expression', clause, afterClause: tail.length === 0 };
}

export function consoleSuggestions(catalog: Catalog, statement: string, before: string, flavor: Flavor): ConsoleSuggestion[] {
	const references = tableReferences(statement);
	const qualifier = QUALIFIER.exec(before);
	if (qualifier) {
		const names = parts(qualifier[1]);
		const referenced = names.length === 1 ? references.get(names[0].toLowerCase()) : undefined;
		const found = findTable(catalog, referenced ?? names, flavor);
		if (found) {
			return columnsOf(found.table, flavor);
		}
		const schema = catalog.databases.flatMap(d => d.schemas).find(s => s.name.toLowerCase() === names[names.length - 1].toLowerCase());
		return schema ? tablesOf(catalog, flavor, schema) : [];
	}
	if (TABLE_CONTEXT.test(before)) {
		const schemas = catalog.databases.flatMap(d => d.schemas)
			.filter(s => !defaultSchemas(catalog, flavor).has(s.name))
			.map((s): ConsoleSuggestion => ({ label: s.name, insert: quoteIdentifier(s.name, QUOTES[flavor]), kind: 'schema', detail: 'schema', sort: '2' }));
		return [...tablesOf(catalog, flavor), ...schemas];
	}
	const { context, clause } = position(before, flavor);
	if (context === 'start') {
		return keywords(START_WORDS[flavor], '2');
	}
	if (context === 'afterTable' && clause) {
		return keywords(AFTER_TABLE_WORDS[clause], '2');
	}
	const columns: ConsoleSuggestion[] = [];
	const seen = new Set<TableInfo>();
	for (const names of references.values()) {
		const found = findTable(catalog, names, flavor);
		if (found && !seen.has(found.table)) {
			seen.add(found.table);
			columns.push(...columnsOf(found.table, flavor, found.table.name));
		}
	}
	return [...columns, ...functions(flavor), ...keywords(EXPRESSION_WORDS, '2'), ...tablesOf(catalog, flavor).map(t => ({ ...t, sort: '3' }))];
}

const POPUP_CLAUSES = new Set(['SELECT', 'WHERE', 'AND', 'OR', 'ON', 'BY', 'SET', 'HAVING', 'WHEN', 'THEN', 'ELSE', 'NOT', 'DISTINCT']);

export function shouldPopup(before: string, flavor: Flavor, suggestions: readonly ConsoleSuggestion[]): boolean {
	if (!suggestions.length) {
		return false;
	}
	const last = before.slice(-1);
	if (last === '.') {
		return true;
	}
	if (COLUMN_LIST.test(before) || /\bis\s+(?:not\s+)?$/i.test(before)) {
		return true;
	}
	if (/\s/.test(last)) {
		if (TABLE_CONTEXT.test(before)) {
			return true;
		}
		const { context, clause, afterClause } = position(before, flavor);
		return context !== 'expression' || (afterClause && !!clause && POPUP_CLAUSES.has(clause));
	}
	const prefix = /[\w$]+$/.exec(before)?.[0];
	if (!prefix || /^\d/.test(prefix)) {
		return false;
	}
	const needle = prefix.toLowerCase();
	return suggestions.some(s => {
		const label = s.label.toLowerCase();
		return label !== needle && (label.startsWith(needle) || (needle.length > 1 && label.includes(needle)));
	});
}
