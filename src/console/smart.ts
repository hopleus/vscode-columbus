import type { Analysis, AnalysisTable } from '../assist/engine';
import type { Catalog, SchemaInfo, TableInfo } from '../catalog';
import { QUOTES, caseInsensitive, quoteIdentifier } from '../shared/format';
import type { Flavor } from '../shared/format';
import { tokenize } from '../shared/sql-assist';
import { tableReferences } from './assist';
import type { ConsoleSuggestion } from './assist';

const NAME = '(?:[\\w$]+|"(?:[^"]|"")+"|`(?:[^`]|``)+`)';
const QUALIFIED = `${NAME}(?:\\.${NAME})?`;
const INSERT_COLUMNS = new RegExp(`\\binsert\\s+into\\s+(${QUALIFIED})\\s*\\(([^)]*)$`, 'i');
const UPDATE_SET = new RegExp(`\\bupdate\\s+(${QUALIFIED})(?:\\s+(?:as\\s+)?[\\w$]+)?\\s+set\\s+(?:[^;]*,\\s*)?[\\w$]*$`, 'i');
const ALIASED = new RegExp(`\\b(?:from|join)\\s+${QUALIFIED}\\s+(?:as\\s+)?(?!(?:on|using|where|join|left|right|inner|full|cross|natural|group|order|limit|having)\\b)[\\w$]+\\s+$`, 'i');
const JOINED = new RegExp(`\\bjoin\\s+(${QUALIFIED})(?:\\s+(?:as\\s+)?(?!on\\b)([\\w$]+))?\\s+(on\\s+[\\w$]*)?$`, 'i');

const PRIORITY = [
	'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'GROUP BY',
	'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'FROM', 'SELECT', 'SET', 'VALUES', 'INTO', 'UNION',
];
const VALUES_ONLY = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE', 'CASE', 'EXISTS', 'INTERVAL', 'DISTINCT', 'ALL', 'NOT']);
const OPERATORS = new Set(['AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE', 'REGEXP', 'BETWEEN', 'ESCAPE']);
const COMMON = new Set([
	'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'REGEXP', 'ESCAPE', 'COLLATE',
	'IS NULL', 'IS NOT NULL', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'ON', 'USING',
	'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'LATERAL',
	'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'LIMIT', 'OFFSET',
	'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'ALL', 'ANY', 'SOME',
	'INTO', 'VALUES', 'SET', 'DEFAULT', 'DEFAULT VALUES', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'ON DUPLICATE KEY UPDATE',
	'WITH', 'RECURSIVE', 'OVER', 'PARTITION BY', 'FILTER', 'WINDOW', 'FOR UPDATE',
	'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'INTERVAL',
]);
const EXPANSIONS: Record<string, string[]> = {
	IS: ['IS NULL', 'IS NOT NULL'],
	NULLS: ['NULLS FIRST', 'NULLS LAST'],
	UNION: ['UNION', 'UNION ALL'],
	FOR: ['FOR UPDATE'],
	PARTITION: ['PARTITION BY'],
	GROUP: ['GROUP BY'],
	ORDER: ['ORDER BY'],
	LEFT: ['LEFT JOIN'],
	RIGHT: ['RIGHT JOIN'],
	INNER: ['INNER JOIN'],
	FULL: ['FULL JOIN'],
};
const FINAL = new Set([
	'IS NULL', 'IS NOT NULL', 'END', 'ASC', 'DESC', 'NULL', 'TRUE', 'FALSE', 'DEFAULT', 'DEFAULT VALUES', 'NULLS FIRST', 'NULLS LAST',
	'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DO NOTHING', 'FOR UPDATE', 'BEGIN', 'COMMIT', 'ROLLBACK',
]);
const CLAUSES: Record<string, number> = { SELECT: 0, FROM: 1, JOIN: 1, ON: 1, USING: 1, WHERE: 2, GROUP: 3, HAVING: 4, WINDOW: 5, ORDER: 6, LIMIT: 7, OFFSET: 7, FETCH: 8, FOR: 9 };
const OTHER_CLAUSES = new Set(['UNION', 'EXCEPT', 'INTERSECT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'RETURNING']);
const STARTS: Record<string, number> = { 'WHERE': 2, 'GROUP BY': 3, 'HAVING': 4, 'WINDOW': 5, 'ORDER BY': 6, 'LIMIT': 7, 'OFFSET': 7, 'FOR UPDATE': 9 };
const FROM_ITEMS = new Set(['JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'LATERAL', 'ON', 'USING']);

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

function unquote(name: string): string {
	const quote = name[0];
	return (quote === '"' || quote === '`') && name.endsWith(quote) ? name.slice(1, -1).split(quote + quote).join(quote) : name;
}

function parts(reference: string): string[] {
	return (reference.match(new RegExp(NAME, 'g')) ?? []).map(unquote);
}

function schemasOf(catalog: Catalog): SchemaInfo[] {
	return catalog.databases.flatMap(d => d.schemas);
}

function defaults(catalog: Catalog, flavor: Flavor): Set<string> {
	if (catalog.current) {
		return new Set(flavor === 'postgres' ? [catalog.current, 'public'] : [catalog.current]);
	}
	const schemas = schemasOf(catalog);
	return new Set(schemas.length === 1 ? [schemas[0].name] : flavor === 'postgres' ? ['public'] : flavor === 'sqlite' ? ['main', 'temp'] : []);
}

function same(flavor: Flavor, a: string, b: string): boolean {
	return caseInsensitive(flavor) ? a.toLowerCase() === b.toLowerCase() : a === b || a === b.toLowerCase();
}

function findTable(catalog: Catalog, names: readonly string[], flavor: Flavor): { schema: string; table: TableInfo } | undefined {
	if (!names.length) {
		return undefined;
	}
	const name = names[names.length - 1];
	const wanted = names.length > 1 ? names[names.length - 2] : undefined;
	const preferred = defaults(catalog, flavor);
	const schemas = schemasOf(catalog)
		.filter(s => !wanted || same(flavor, s.name, wanted))
		.sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)));
	for (const schema of schemas) {
		const table = schema.tables.find(t => same(flavor, t.name, name));
		if (table) {
			return { schema: schema.name, table };
		}
	}
	return undefined;
}

interface Clause {
	word: string | undefined;
	empty: boolean;
}

function currentClause(before: string, flavor: Flavor): Clause {
	const levels: Clause[] = [{ word: undefined, empty: true }];
	for (const token of tokenize(before, flavor, [])) {
		if (token.kind === 'string' || token.kind === 'comment' || token.kind === 'space') {
			continue;
		}
		const level = levels[levels.length - 1];
		if (token.text === '(') {
			level.empty = false;
			levels.push({ word: undefined, empty: true });
		} else if (token.text === ')') {
			if (levels.length > 1) {
				levels.pop();
			}
		} else {
			const word = token.text.toUpperCase();
			if (word in CLAUSES || OTHER_CLAUSES.has(word)) {
				levels[levels.length - 1] = { word, empty: true };
			} else if (word !== 'BY') {
				level.empty = false;
			}
		}
	}
	return levels[levels.length - 1];
}

const CONTINUATIONS = new Set(['FROM', 'AS', 'INTO', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', ...FROM_ITEMS, ...Object.keys(STARTS)]);

function fits(word: string, clause: Clause, expression: boolean): boolean {
	if (clause.empty && clause.word && CONTINUATIONS.has(word)) {
		return false;
	}
	if (VALUES_ONLY.has(word) && !expression) {
		return false;
	}
	if (word === 'VALUES' || word === 'INTO') {
		return clause.word === 'INSERT';
	}
	if (word === 'PARTITION BY') {
		return clause.empty && clause.word === undefined;
	}
	const current = clause.word === undefined ? undefined : CLAUSES[clause.word];
	if (current === undefined) {
		return true;
	}
	if (word === 'FROM') {
		return current === 0;
	}
	if (word === 'AS') {
		return current <= 1;
	}
	if (FROM_ITEMS.has(word)) {
		return current === 1;
	}
	const start = STARTS[word];
	return start === undefined || start > current || (start === 7 && current === 7);
}

function keywordItems(words: readonly string[], clause: Clause, expression: boolean): ConsoleSuggestion[] {
	const set = new Set(words.flatMap(word => EXPANSIONS[word] ?? [word]));
	const rank = (word: string): number => {
		const index = PRIORITY.indexOf(word);
		return index < 0 ? PRIORITY.length : index;
	};
	return [...set]
		.filter(word => COMMON.has(word) && fits(word, clause, expression) && !(OPERATORS.has(word) && !clause.empty && (clause.word === 'ORDER' || clause.word === 'GROUP')))
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
		.map(word => ({ label: word, insert: FINAL.has(word) ? word : `${word} `, kind: 'keyword', detail: '', sort: '2', retrigger: !FINAL.has(word) }));
}

function columnItems(names: readonly string[], owner: string, types: Map<string, string>, flavor: Flavor, sort = '0', ambiguous?: ReadonlySet<string>): ConsoleSuggestion[] {
	const quote = QUOTES[flavor];
	return names.map(name => ({
		label: name,
		insert: ambiguous?.has(name) && owner ? `${quoteIdentifier(owner, quote)}.${quoteIdentifier(name, quote)}` : quoteIdentifier(name, quote),
		kind: 'column',
		detail: types.get(name) ?? '',
		sort,
		owner: ambiguous ? owner : undefined,
	}));
}

function tableColumns(catalog: Catalog, table: AnalysisTable, flavor: Flavor): { owner: string; names: string[]; types: Map<string, string> } | undefined {
	if (table.columns) {
		return { owner: table.alias ?? table.name[table.name.length - 1] ?? '', names: table.columns, types: new Map() };
	}
	const found = findTable(catalog, table.name, flavor);
	return found && {
		owner: table.alias ?? found.table.name,
		names: found.table.columns.map(c => c.name),
		types: new Map(found.table.columns.map(c => [c.name, c.type])),
	};
}

function routineItems(catalog: Catalog, flavor: Flavor): ConsoleSuggestion[] {
	const preferred = defaults(catalog, flavor);
	const quote = QUOTES[flavor];
	const escape = (text: string): string => text.replace(/[$}\\]/g, '\\$&');
	const seen = new Set<string>();
	return schemasOf(catalog).flatMap(schema => (schema.objects ?? []).flatMap((routine): ConsoleSuggestion[] => {
		if (routine.type !== 'function' && routine.type !== 'aggregate') {
			return [];
		}
		const qualified = !preferred.has(schema.name);
		const label = qualified ? `${schema.name}.${routine.name}` : routine.name;
		if (seen.has(label)) {
			return [];
		}
		seen.add(label);
		const name = `${qualified ? `${quoteIdentifier(schema.name, quote)}.` : ''}${quoteIdentifier(routine.name, quote)}`;
		const empty = routine.detail?.startsWith('()') ?? false;
		return [{ label, insert: `${escape(name)}(${empty ? '' : '$1'})`, kind: 'function', detail: routine.detail ?? schema.name, sort: '1', snippet: true }];
	}));
}

function tableItems(catalog: Catalog, flavor: Flavor, only?: SchemaInfo): ConsoleSuggestion[] {
	const preferred = defaults(catalog, flavor);
	const quote = QUOTES[flavor];
	return (only ? [only] : schemasOf(catalog)).flatMap(schema => schema.tables.map((table): ConsoleSuggestion => {
		const qualified = !only && !preferred.has(schema.name);
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

function joinConditions(catalog: Catalog, analysis: Analysis, joined: { names: string[]; alias?: string }, flavor: Flavor): string[] {
	const quote = QUOTES[flavor];
	const target = findTable(catalog, joined.names, flavor);
	if (!target) {
		return [];
	}
	const targetName = joined.alias ?? target.table.name;
	const conditions: string[] = [];
	for (const other of analysis.tables) {
		const found = findTable(catalog, other.name, flavor);
		if (!found || found.table === target.table) {
			continue;
		}
		const otherName = other.alias ?? found.table.name;
		const ref = (owner: string, column: string): string => `${quoteIdentifier(owner, quote)}.${quoteIdentifier(column, quote)}`;
		for (const key of target.table.foreignKeys) {
			if (key.columns.length === 1 && same(flavor, key.refTable.split('.').pop() ?? '', found.table.name)) {
				conditions.push(`${ref(targetName, key.columns[0])} = ${ref(otherName, key.refColumns[0])}`);
			}
		}
		for (const key of found.table.foreignKeys) {
			if (key.columns.length === 1 && same(flavor, key.refTable.split('.').pop() ?? '', target.table.name)) {
				conditions.push(`${ref(targetName, key.refColumns[0])} = ${ref(otherName, key.columns[0])}`);
			}
		}
	}
	return conditions;
}

export function wordStart(before: string): number {
	return before.length - (/[\w$]*$/.exec(before)?.[0].length ?? 0);
}

function scopeTables(analysis: Analysis, statement: string): AnalysisTable[] {
	if (analysis.tables.length) {
		return analysis.tables;
	}
	const tables: AnalysisTable[] = [];
	const aliased = new Set<string>();
	for (const [key, names] of tableReferences(statement)) {
		const name = names[names.length - 1].toLowerCase();
		if (key !== name) {
			tables.push({ name: names, alias: key });
			aliased.add(name);
		}
	}
	for (const [key, names] of tableReferences(statement)) {
		if (key === names[names.length - 1].toLowerCase() && !aliased.has(key)) {
			tables.push({ name: names });
		}
	}
	return tables;
}

const AFTER_IS = /\bis\s+(not\s+)?[\w$]*$/i;

export function columnListSuggestions(catalog: Catalog, before: string, flavor: Flavor): ConsoleSuggestion[] | undefined {
	const is = AFTER_IS.exec(before);
	if (is) {
		const words = is[1]
			? ['NULL', 'TRUE', 'FALSE', ...(flavor === 'postgres' ? ['DISTINCT FROM'] : [])]
			: ['NULL', 'NOT NULL', 'TRUE', 'FALSE', ...(flavor === 'postgres' ? ['DISTINCT FROM', 'NOT DISTINCT FROM'] : [])];
		return words.map(word => ({ label: word, insert: word.endsWith('FROM') ? `${word} ` : word, kind: 'keyword', detail: '', sort: '0', retrigger: word.endsWith('FROM') }));
	}
	const insert = INSERT_COLUMNS.exec(before);
	if (insert) {
		const found = findTable(catalog, parts(insert[1]), flavor);
		if (found) {
			const listed = new Set(insert[2].split(',').map(c => unquote(c.trim())).filter(Boolean));
			const free = found.table.columns.filter(c => !listed.has(c.name));
			const all = free.filter(c => !c.generated).map(c => quoteIdentifier(c.name, QUOTES[flavor])).join(', ');
			const types = new Map(found.table.columns.map(c => [c.name, c.type]));
			return [
				...(listed.size || !all ? [] : [{ label: all, insert: all, kind: 'column' as const, detail: 'all columns', sort: '0' }]),
				...columnItems(free.map(c => c.name), '', types, flavor, '1'),
			];
		}
	}
	const update = UPDATE_SET.exec(before);
	if (update) {
		const found = findTable(catalog, parts(update[1]), flavor);
		if (found) {
			return found.table.columns.filter(c => !c.generated).map(c => ({
				label: c.name,
				insert: `${quoteIdentifier(c.name, QUOTES[flavor])} = `,
				kind: 'column',
				detail: c.type,
				sort: '0',
			}));
		}
	}
	return undefined;
}

export function smartSuggestions(catalog: Catalog, analysis: Analysis, statement: string, before: string, flavor: Flavor): ConsoleSuggestion[] {
	analysis = { ...analysis, tables: scopeTables(analysis, statement) };
	const listed = columnListSuggestions(catalog, before, flavor);
	if (listed) {
		return listed;
	}

	const prefix = /[\w$]*$/.exec(before)?.[0] ?? '';
	const result: ConsoleSuggestion[] = [];
	const joined = JOINED.exec(before);
	if (joined) {
		const conditions = joinConditions(catalog, analysis, { names: parts(joined[1]), alias: joined[2] }, flavor);
		const afterOn = !!joined[3];
		result.push(...conditions.map((condition): ConsoleSuggestion => ({
			label: afterOn ? condition : `ON ${condition}`,
			insert: afterOn ? condition : `ON ${condition}`,
			kind: 'keyword',
			detail: 'foreign key',
			sort: '0',
		})));
	}

	const relevant = analysis.contexts.filter(c => !c.words.length || c.words[c.words.length - 1] === '.' || c.words[c.words.length - 1] === prefix);
	const qualified = relevant.find(c => c.words.length > 1 && c.words[c.words.length - 1] === '.' || (c.words.length > 2 && c.words[c.words.length - 2] === '.'));
	if (qualified) {
		const words = qualified.words[qualified.words.length - 1] === '.' ? qualified.words.slice(0, -1) : qualified.words.slice(0, -2);
		const qualifier = parts(words.join(''));
		const last = qualifier[qualifier.length - 1] ?? '';
		const table = qualifier.length === 1
			? analysis.tables.find(t => (t.alias && same(flavor, t.alias, last)) || (!t.alias && t.name.length && same(flavor, t.name[t.name.length - 1], last)))
			: undefined;
		const columns = tableColumns(catalog, table ?? { name: qualifier }, flavor);
		if (columns) {
			return [...result, ...columnItems(columns.names, '', columns.types, flavor)];
		}
		const schema = schemasOf(catalog).find(s => same(flavor, s.name, last));
		return schema ? tableItems(catalog, flavor, schema) : result;
	}

	const types = new Set(relevant.map(c => c.type));
	const tableContext = types.has('table') || types.has('view');
	const afterTable = analysis.keywords.includes('JOIN');
	if (types.has('column') && !afterTable) {
		const scoped = new Map<string, NonNullable<ReturnType<typeof tableColumns>>>();
		for (const table of analysis.tables) {
			const columns = tableColumns(catalog, table, flavor);
			if (columns && !scoped.has(columns.owner)) {
				scoped.set(columns.owner, columns);
			}
		}
		const counts = new Map<string, number>();
		for (const columns of scoped.values()) {
			for (const name of columns.names) {
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
		}
		const ambiguous = scoped.size > 1 ? new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name)) : undefined;
		for (const columns of scoped.values()) {
			result.push(...columnItems(columns.names, columns.owner, columns.types, flavor, '0', ambiguous));
		}
	}
	if (types.has('function') && !afterTable && !tableContext && prefix) {
		result.push(...FUNCTIONS[flavor].map(([name, snippet]): ConsoleSuggestion => ({ label: name, insert: snippet, kind: 'function', detail: '', sort: '1', snippet: true })));
		result.push(...routineItems(catalog, flavor));
	}
	if (tableContext) {
		const schemas = schemasOf(catalog)
			.filter(s => !defaults(catalog, flavor).has(s.name))
			.map((s): ConsoleSuggestion => ({ label: s.name, insert: quoteIdentifier(s.name, QUOTES[flavor]), kind: 'schema', detail: '', sort: '2' }));
		result.push(...tableItems(catalog, flavor).map(t => ({ ...t, sort: '0' })), ...schemas);
	}
	if (types.has('database')) {
		result.push(...schemasOf(catalog).map((s): ConsoleSuggestion => ({ label: s.name, insert: quoteIdentifier(s.name, QUOTES[flavor]), kind: 'schema', detail: '', sort: '1' })));
	}
	if (!tableContext || prefix) {
		const aliased = ALIASED.test(before.slice(0, wordStart(before)));
		result.push(...keywordItems(analysis.keywords, currentClause(before.slice(0, wordStart(before)), flavor), types.has('column') || types.has('function')).filter(k => !(aliased && k.label === 'AS')));
	}
	if (!tableContext && !afterTable && types.has('column') && prefix) {
		result.push(...tableItems(catalog, flavor).map(t => ({ ...t, sort: '3' })));
	}
	return result;
}
