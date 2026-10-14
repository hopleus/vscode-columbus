import type { Catalog, TableInfo } from '../catalog';
import { QUOTES, caseInsensitive, quoteIdentifier } from '../shared/format';
import type { Flavor } from '../shared/format';
import { tokenize } from '../shared/sql-assist';
import type { Token } from '../shared/sql-assist';
import { SQL_KEYWORDS } from '../shared/sql-keywords';
import { splitStatements } from '../shared/statements';
import { selectItems } from './paging';
import type { SelectItem } from './paging';

export type SymbolKind = 'schema' | 'table' | 'view' | 'column' | 'alias';

export interface SymbolToken {
	start: number;
	length: number;
	kind: SymbolKind;
	declaration: boolean;
}

export interface Problem {
	start: number;
	length: number;
	message: string;
	suggestions: string[];
}

export interface Semantics {
	symbols: SymbolToken[];
	problems: Problem[];
}

interface Name {
	index: number;
	token: Token;
	name: string;
	quoted: boolean;
}

interface Level {
	id: number;
	query: boolean;
	clause: string | undefined;
	cast: boolean;
}

interface Reference {
	level: number;
	parts: Name[];
	alias?: Name;
	table?: { schema: string; info: TableInfo };
	columns?: string[];
	opaque: boolean;
	diagnosable: boolean;
}

const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'ON', 'USING', 'SET', 'VALUES', 'RETURNING', 'INTO', 'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'UPDATE', 'DELETE', 'INSERT']);
const NOT_ALIASES = new Set([
	'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
	'FETCH', 'FOR', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'SET', 'VALUES', 'RETURNING', 'SELECT', 'LATERAL', 'TABLESAMPLE', 'STRAIGHT_JOIN',
	'PARTITION', 'USE', 'IGNORE', 'FORCE', 'DEFAULT', 'OVERRIDING', 'ONLY', 'AS', 'WITH', 'LOCK', 'INTO', 'FROM', 'AND', 'OR', 'NOT',
]);
const DML = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'TABLE', 'REPLACE']);
const LEADING = new Set(['EXPLAIN', 'ANALYZE', 'ANALYSE', 'VERBOSE']);
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast', 'mysql', 'performance_schema', 'sys']);
const TYPES = new Set([
	'int', 'int2', 'int4', 'int8', 'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'text', 'varchar', 'char', 'character', 'bool', 'boolean',
	'numeric', 'decimal', 'real', 'float', 'float4', 'float8', 'double', 'json', 'jsonb', 'uuid', 'bytea', 'date', 'time', 'timetz', 'timestamp',
	'timestamptz', 'interval', 'inet', 'cidr', 'macaddr', 'money', 'xml', 'citext', 'regclass', 'oid', 'tsvector', 'tsquery', 'point', 'name',
	'signed', 'unsigned', 'datetime', 'tinyint', 'mediumint', 'longtext', 'mediumtext', 'tinytext', 'blob', 'longblob', 'binary', 'varbinary',
]);

function outputs(items: readonly SelectItem[] | undefined): string[] | undefined {
	const names = items?.map(item => item.star ? undefined : item.alias ?? item.column);
	return names && names.every((name): name is string => !!name) ? names : undefined;
}

function isName(token: Token | undefined): token is Token {
	return !!token && (token.kind === 'identifier' || token.kind === 'keyword' || token.kind === 'function' || token.kind === 'column');
}

function unquote(text: string): { name: string; quoted: boolean } {
	const quote = text[0];
	if ((quote === '"' || quote === '`') && text.length > 1 && text.endsWith(quote)) {
		return { name: text.slice(1, -1).split(quote + quote).join(quote), quoted: true };
	}
	return { name: text, quoted: false };
}

function distance(a: string, b: string): number {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[a.length][b.length];
}

function similar(name: string, candidates: readonly string[]): string[] {
	const needle = name.toLowerCase();
	return [...new Set(candidates)]
		.map(candidate => ({ candidate, score: distance(needle, candidate.toLowerCase()) }))
		.filter(({ candidate, score }) => (name.length >= 3 && score <= Math.max(1, Math.floor(name.length / 3))) || (needle.length >= 2 && candidate.toLowerCase().startsWith(needle)))
		.sort((a, b) => a.score - b.score)
		.slice(0, 3)
		.map(({ candidate }) => candidate);
}

class Analyzer {
	private readonly words: Token[];
	private readonly levels: Level[] = [];
	private readonly levelOf: number[] = [];
	private readonly clauseOf: (string | undefined)[] = [];
	private readonly castOf: boolean[] = [];
	private readonly closing = new Map<number, number>();
	private readonly references: Reference[] = [];
	private readonly ctes = new Map<string, string[] | undefined>();
	private readonly declared = new Set<number>();
	private readonly aliases = new Set<string>();
	private readonly symbols: SymbolToken[] = [];
	private readonly problems: Problem[] = [];
	private readonly dml: boolean;
	private readonly kind: string;

	constructor(
		private readonly catalog: Catalog,
		private readonly text: string,
		private readonly base: number,
		private readonly flavor: Flavor,
		private readonly created: ReadonlySet<string>
	) {
		this.words = tokenize(text, flavor, []).filter(t => t.kind !== 'space' && t.kind !== 'comment');
		let first = 0;
		while (first < this.words.length && LEADING.has(this.words[first].text.toUpperCase())) {
			first++;
		}
		this.kind = this.words[first]?.text.toUpperCase() ?? '';
		this.dml = DML.has(this.kind);
		this.structure();
	}

	run(): Semantics {
		this.collectCtes();
		this.collectReferences();
		this.classify();
		return { symbols: this.symbols, problems: this.problems };
	}

	expand(offset: number): { start: number; length: number; text: string } | undefined {
		this.collectCtes();
		this.collectReferences();
		const index = this.words.findIndex(t => t.text === '*' && t.start <= offset && offset <= t.start + 1);
		if (index < 0) {
			return undefined;
		}
		const previous = this.words[index - 1];
		const level = this.levelOf[index];
		const quote = QUOTES[this.flavor];
		if (previous?.text === '.' && isName(this.words[index - 2])) {
			const qualifier = this.name(index - 2);
			if (this.words[index - 3]?.text === '.') {
				return undefined;
			}
			const reference = this.findReference(qualifier.name);
			if (!reference?.columns) {
				return undefined;
			}
			const owner = this.words[index - 2];
			return {
				start: this.base + owner.start,
				length: this.words[index].start + 1 - owner.start,
				text: reference.columns.map(c => `${owner.text}.${quoteIdentifier(c, quote)}`).join(', '),
			};
		}
		const upper = previous?.text.toUpperCase();
		if (upper !== 'SELECT' && upper !== 'DISTINCT' && upper !== 'ALL' && previous?.text !== ',' && upper !== 'RETURNING') {
			return undefined;
		}
		const visible = this.references.filter(r => r.level === level && r.columns);
		if (!visible.length || this.references.some(r => r.level === level && !r.columns)) {
			return undefined;
		}
		const qualify = visible.length > 1;
		const columns = visible.flatMap(r => r.columns!.map(c => {
			const name = quoteIdentifier(c, quote);
			return qualify ? `${r.alias?.token.text ?? r.parts[r.parts.length - 1].token.text}.${name}` : name;
		}));
		return { start: this.base + this.words[index].start, length: 1, text: columns.join(', ') };
	}

	private structure(): void {
		let nextId = 0;
		const stack: Level[] = [{ id: nextId++, query: true, clause: undefined, cast: false }];
		this.levels.push(stack[0]);
		const opened: number[] = [];
		this.words.forEach((token, index) => {
			const text = token.text;
			if (text === '(') {
				const next = this.words[index + 1]?.text.toUpperCase();
				const before = this.words[index - 1]?.text.toUpperCase();
				const parent = stack[stack.length - 1];
				const level: Level = {
					id: nextId++,
					query: next === 'SELECT' || next === 'WITH' || next === 'VALUES' || next === 'TABLE',
					clause: parent.clause,
					cast: before === 'CAST' || before === 'TRY_CAST' || before === 'CONVERT',
				};
				this.levelOf[index] = parent.id;
				this.clauseOf[index] = parent.clause;
				this.castOf[index] = parent.cast;
				stack.push(level);
				this.levels.push(level);
				opened.push(index);
				return;
			}
			if (text === ')' && stack.length > 1) {
				stack.pop();
				const open = opened.pop();
				if (open !== undefined) {
					this.closing.set(open, index);
				}
			}
			const level = stack[stack.length - 1];
			const upper = text.toUpperCase();
			if (level.query && token.kind !== 'string' && CLAUSES.has(upper) && !(upper === 'ON' && this.words[index - 1]?.text.toUpperCase() === 'DISTINCT')) {
				level.clause = upper === 'JOIN' ? 'FROM' : upper;
			}
			this.levelOf[index] = level.id;
			this.clauseOf[index] = level.clause;
			this.castOf[index] = level.cast;
		});
	}

	private name(index: number): Name {
		const token = this.words[index];
		const { name, quoted } = unquote(token.text);
		return { index, token, name, quoted };
	}

	private same(word: Name | string, name: string): boolean {
		const text = typeof word === 'string' ? word : word.name;
		const quoted = typeof word === 'string' ? false : word.quoted;
		if (caseInsensitive(this.flavor)) {
			return text.toLowerCase() === name.toLowerCase();
		}
		return quoted ? text === name : text.toLowerCase() === name || text === name;
	}

	private schemas() {
		return this.catalog.databases.flatMap(d => d.schemas);
	}

	private findTable(parts: readonly Name[]): { schema: string; info: TableInfo } | undefined {
		const table = parts[parts.length - 1];
		const schemaName = parts.length > 1 ? parts[parts.length - 2] : undefined;
		const preferred = [this.catalog.current, this.flavor === 'postgres' ? 'public' : this.flavor === 'sqlite' ? 'main' : undefined].filter((s): s is string => !!s);
		const schemas = this.schemas()
			.filter(s => !schemaName || this.same(schemaName, s.name))
			.sort((a, b) => Number(preferred.includes(b.name)) - Number(preferred.includes(a.name)));
		for (const schema of schemas) {
			const info = schema.tables.find(t => this.same(table, t.name));
			if (info) {
				return { schema: schema.name, info };
			}
		}
		return undefined;
	}

	private symbol(token: Token, kind: SymbolKind, declaration = false): void {
		this.symbols.push({ start: this.base + token.start, length: token.text.length, kind, declaration });
	}

	private problem(token: Token, message: string, suggestions: string[] = []): void {
		this.problems.push({ start: this.base + token.start, length: token.text.length, message, suggestions });
	}

	private collectCtes(): void {
		if (this.ctes.size || this.words[0]?.text.toUpperCase() !== 'WITH') {
			return;
		}
		let i = 1;
		if (this.words[i]?.text.toUpperCase() === 'RECURSIVE') {
			i++;
		}
		while (isName(this.words[i])) {
			const name = this.name(i);
			let columns: string[] | undefined;
			i++;
			if (this.words[i]?.text === '(') {
				const close = this.closing.get(i) ?? i;
				columns = this.words.slice(i + 1, close).filter(isName).map(t => unquote(t.text).name);
				this.words.slice(i + 1, close).filter(isName).forEach(t => this.symbol(t, 'column', true));
				i = close + 1;
			}
			if (this.words[i]?.text.toUpperCase() !== 'AS') {
				return;
			}
			i++;
			while (/^(NOT|MATERIALIZED)$/i.test(this.words[i]?.text ?? '')) {
				i++;
			}
			if (this.words[i]?.text !== '(') {
				return;
			}
			const close = this.closing.get(i) ?? i;
			if (!columns) {
				const body = this.text.slice(this.words[i + 1]?.start ?? 0, this.words[close]?.start ?? this.text.length);
				const items = selectItems(body, this.flavor);
				columns = outputs(items);
			}
			this.ctes.set(name.name.toLowerCase(), columns);
			this.declared.add(name.index);
			this.symbol(name.token, 'table', true);
			i = close + 1;
			if (this.words[i]?.text !== ',') {
				return;
			}
			i++;
		}
	}

	private collectReferences(): void {
		if (this.references.length) {
			return;
		}
		for (let i = 0; i < this.words.length; i++) {
			const upper = this.words[i].text.toUpperCase();
			if (this.words[i].kind === 'string' || !this.levelIsQuery(i)) {
				continue;
			}
			const previous = this.words[i - 1]?.text.toUpperCase();
			const tablePosition =
				(upper === 'FROM' && previous !== 'DISTINCT') ||
				upper === 'JOIN' ||
				upper === 'INTO' ||
				(upper === 'UPDATE' && previous !== 'FOR' && previous !== 'KEY' && previous !== 'DO') ||
				(upper === 'TABLE' && previous !== 'RETURNS') ||
				(upper === 'TRUNCATE' && this.words[i + 1]?.text.toUpperCase() !== 'TABLE') ||
				(upper === 'USING' && this.kind === 'DELETE' && this.words[i + 1]?.text !== '(');
			if (!tablePosition) {
				continue;
			}
			const list = upper === 'FROM' || upper === 'USING';
			const diagnosable = this.dml && !(upper === 'INTO' && this.kind === 'SELECT');
			let j = i + 1;
			do {
				if (this.words[j]?.text === ',') {
					j++;
				}
				j = this.reference(j, diagnosable, upper === 'INTO' || upper === 'UPDATE');
			} while (list && this.words[j]?.text === ',' && this.levelOf[j] === this.levelOf[i]);
		}
	}

	private levelIsQuery(index: number): boolean {
		const id = this.levelOf[index];
		return this.levels.find(l => l.id === id)?.query ?? false;
	}

	private reference(start: number, diagnosable: boolean, target: boolean): number {
		let i = start;
		while (/^(ONLY|LATERAL|TABLE|IF|NOT|EXISTS|IGNORE)$/i.test(this.words[i]?.text ?? '') && this.words[i + 1]?.text !== ',') {
			i++;
		}
		const level = this.levelOf[start];
		if (this.words[i]?.text === '(') {
			const close = this.closing.get(i) ?? i;
			const body = this.text.slice(this.words[i + 1]?.start ?? 0, this.words[close]?.start ?? this.text.length);
			const items = selectItems(body, this.flavor);
			const columns = outputs(items);
			return this.aliasAfter(close + 1, { level, parts: [], columns, opaque: !columns, diagnosable: false });
		}
		if (!isName(this.words[i])) {
			return i;
		}
		const parts: Name[] = [this.name(i)];
		i++;
		while (this.words[i]?.text === '.' && isName(this.words[i + 1])) {
			parts.push(this.name(i + 1));
			i += 2;
		}
		if (this.words[i]?.text === '(' && !target) {
			const close = this.closing.get(i) ?? i;
			parts.forEach(part => this.declared.add(part.index));
			return this.aliasAfter(close + 1, { level, parts: [], opaque: true, diagnosable: false });
		}
		const reference: Reference = { level, parts, opaque: false, diagnosable };
		parts.forEach(part => this.declared.add(part.index));
		const cte = parts.length === 1 ? this.ctes.get(parts[0].name.toLowerCase()) : undefined;
		if (parts.length === 1 && this.ctes.has(parts[0].name.toLowerCase())) {
			reference.columns = cte;
			reference.opaque = !cte;
			this.symbol(parts[0].token, 'table');
		} else {
			const found = this.findTable(parts);
			if (found) {
				reference.table = found;
				reference.columns = found.info.columns.map(c => c.name);
				if (parts.length > 1) {
					this.symbol(parts[parts.length - 2].token, 'schema');
				}
				this.symbol(parts[parts.length - 1].token, found.info.kind === 'view' ? 'view' : 'table');
			} else {
				reference.opaque = true;
				const name = parts[parts.length - 1];
				const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
				const knownSchema = schema && this.schemas().find(s => this.same(schema, s.name));
				if (knownSchema) {
					this.symbol(schema.token, 'schema');
				}
				const system = (schema && SYSTEM_SCHEMAS.has(schema.name.toLowerCase())) || (!schema && /^pg_/i.test(name.name)) || (!schema && /^dual$/i.test(name.name));
				const created = this.created.has(name.name.toLowerCase());
				if (diagnosable && !system && !created && (!schema || knownSchema) && this.schemas().length) {
					const candidates = (knownSchema ? [knownSchema] : this.schemas()).flatMap(s => s.tables.map(t => t.name));
					this.problem(name.token, `Unable to resolve table '${name.name}'`, similar(name.name, candidates));
				}
			}
		}
		if (target && this.words[i]?.text === '(' && this.levelOf[i] === level && !/^(SELECT|WITH|VALUES)$/i.test(this.words[i + 1]?.text ?? '')) {
			const close = this.closing.get(i) ?? i;
			for (let k = i + 1; k < close; k++) {
				if (isName(this.words[k])) {
					this.declared.add(k);
					this.column(this.name(k), reference, diagnosable);
				}
			}
			this.references.push(reference);
			return close + 1;
		}
		return this.aliasAfter(i, reference);
	}

	private aliasAfter(start: number, reference: Reference): number {
		let i = start;
		if (this.words[i]?.text.toUpperCase() === 'AS') {
			i++;
		}
		const word = this.words[i];
		if (isName(word) && !NOT_ALIASES.has(word.text.toUpperCase()) && word.kind !== 'function') {
			reference.alias = this.name(i);
			this.declared.add(i);
			this.symbol(word, 'alias', true);
			i++;
			if (this.words[i]?.text === '(') {
				const close = this.closing.get(i) ?? i;
				const columns = this.words.slice(i + 1, close).filter(isName);
				columns.forEach(t => {
					this.declared.add(this.words.indexOf(t));
					this.symbol(t, 'column', true);
				});
				reference.columns = columns.map(t => unquote(t.text).name);
				reference.opaque = false;
				i = close + 1;
			}
		}
		this.references.push(reference);
		return i;
	}

	private findReference(name: string): Reference | undefined {
		const lower = name.toLowerCase();
		return this.references.find(r => r.alias && r.alias.name.toLowerCase() === lower)
			?? this.references.find(r => !r.alias && r.parts.length && r.parts[r.parts.length - 1].name.toLowerCase() === lower)
			?? this.references.find(r => r.parts.length && r.parts[r.parts.length - 1].name.toLowerCase() === lower)
			?? (lower === 'excluded' ? this.references.find(r => r.diagnosable && r.table) : undefined);
	}

	private column(word: Name, reference: Reference, diagnosable: boolean): void {
		if (!reference.columns) {
			return;
		}
		if (reference.columns.some(c => this.same(word, c))) {
			this.symbol(word.token, 'column');
		} else if (diagnosable && this.dml && !reference.opaque) {
			this.problem(word.token, `Unable to resolve column '${word.name}'`, similar(word.name, reference.columns));
		}
	}

	private classify(): void {
		for (let i = 0; i < this.words.length; i++) {
			const word = this.words[i];
			if (word.text.toUpperCase() === 'AS' && isName(this.words[i + 1]) && !this.castOf[i + 1] && !this.declared.has(i + 1)) {
				this.aliases.add(unquote(this.words[i + 1].text).name.toLowerCase());
			}
		}
		for (let i = 0; i < this.words.length; i++) {
			if (!isName(this.words[i]) || this.declared.has(i) || this.words[i - 1]?.text === '.') {
				continue;
			}
			const chain: Name[] = [this.name(i)];
			let j = i + 1;
			while (this.words[j]?.text === '.' && isName(this.words[j + 1]) && !NOT_ALIASES.has(this.words[j + 1].text.toUpperCase())) {
				chain.push(this.name(j + 1));
				j += 2;
			}
			const call = this.words[j]?.text === '(';
			if (chain.length === 1) {
				this.single(chain[0], call);
			} else {
				this.qualified(chain, call);
			}
			i = j - 1;
		}
	}

	private single(word: Name, call: boolean): void {
		const index = word.index;
		const previous = this.words[index - 1];
		const next = this.words[index + 1];
		const upper = word.token.text.toUpperCase();
		if (call || previous?.text === '::' || previous?.text === ':' || previous?.text === '@' || next?.kind === 'string' || this.castOf[index]) {
			return;
		}
		if (previous?.text.toUpperCase() === 'AS' || this.implicitAlias(index)) {
			if (this.clauseOf[index] === 'SELECT' || this.clauseOf[index] === 'RETURNING') {
				this.symbol(word.token, 'alias', true);
			}
			return;
		}
		if (previous?.text.toUpperCase() === 'OVER' || previous?.text.toUpperCase() === 'WINDOW') {
			return;
		}
		const lower = word.name.toLowerCase();
		const alias = this.references.find(r => r.alias && r.alias.name.toLowerCase() === lower);
		if (alias) {
			this.symbol(word.token, 'alias');
			return;
		}
		const assigned = this.clauseOf[index] === 'SET' && next?.text === '=' && (previous?.text.toUpperCase() === 'SET' || previous?.text === ',');
		const target = assigned ? this.references.find(r => r.diagnosable && r.table && this.kind === 'UPDATE') : undefined;
		if (target) {
			this.column(word, target, true);
			return;
		}
		if (this.references.some(r => r.columns?.some(c => this.same(word, c)))) {
			this.symbol(word.token, 'column');
			return;
		}
		if (this.aliases.has(lower)) {
			this.symbol(word.token, 'alias');
			return;
		}
		const table = this.references.find(r => r.parts.length && this.same(word, r.parts[r.parts.length - 1].name));
		if (table) {
			this.symbol(word.token, table.table?.info.kind === 'view' ? 'view' : 'table');
			return;
		}
		if ((!word.quoted && SQL_KEYWORDS.has(upper)) || TYPES.has(lower) || word.token.kind === 'keyword') {
			return;
		}
		const clause = this.clauseOf[index];
		const known = this.references.length > 0 && this.references.every(r => !r.opaque && r.columns);
		if (this.dml && clause && /^(SELECT|WHERE|ON|HAVING|SET)$/.test(clause) && known) {
			this.problem(word.token, `Unable to resolve column '${word.name}'`, similar(word.name, this.references.flatMap(r => r.columns ?? [])));
		}
	}

	private implicitAlias(index: number): boolean {
		const clause = this.clauseOf[index];
		if (clause !== 'SELECT' && clause !== 'RETURNING') {
			return false;
		}
		const previous = this.words[index - 1];
		if (!previous) {
			return false;
		}
		const next = this.words[index + 1];
		const ends = !next || next.text === ',' || /^(FROM|INTO|WHERE|GROUP|ORDER|LIMIT|UNION|EXCEPT|INTERSECT|HAVING|WINDOW)$/i.test(next.text) || next.text === ')' || next.text === ';';
		if (!ends) {
			return false;
		}
		if (previous.text === ')' || previous.kind === 'number' || previous.kind === 'string' || previous.text === '*') {
			return true;
		}
		return isName(previous) && !/^(SELECT|DISTINCT|ALL|AND|OR|NOT|IS|NULL|CASE|WHEN|THEN|ELSE|IN|LIKE|BETWEEN|RETURNING)$/i.test(previous.text) && this.words[index - 2]?.text !== 'AS' && previous.text.toUpperCase() !== 'AS';
	}

	private qualified(chain: Name[], call: boolean): void {
		const [first, second] = chain;
		const last = chain[chain.length - 1];
		const reference = chain.length === 2 ? this.findReference(first.name) : undefined;
		if (reference) {
			this.symbol(first.token, reference.alias && reference.alias.name.toLowerCase() === first.name.toLowerCase() ? 'alias' : reference.table?.info.kind === 'view' ? 'view' : 'table');
			if (!call) {
				this.column(second, reference, true);
			}
			return;
		}
		const schema = this.schemas().find(s => this.same(first, s.name));
		if (schema) {
			this.symbol(first.token, 'schema');
			const table = schema.tables.find(t => this.same(second, t.name));
			if (table && !call) {
				this.symbol(second.token, table.kind === 'view' ? 'view' : 'table');
				if (chain.length === 3) {
					if (table.columns.some(c => this.same(last, c.name))) {
						this.symbol(last.token, 'column');
					} else if (this.dml) {
						this.problem(last.token, `Unable to resolve column '${last.name}'`, similar(last.name, table.columns.map(c => c.name)));
					}
				}
			}
			return;
		}
		if (call || chain.length !== 2 || !this.dml || SQL_KEYWORDS.has(first.token.text.toUpperCase()) || SYSTEM_SCHEMAS.has(first.name.toLowerCase())) {
			return;
		}
		if (this.references.some(r => r.opaque && !r.alias && !r.parts.length)) {
			return;
		}
		const names = this.references.flatMap(r => [r.alias?.name, r.parts[r.parts.length - 1]?.name]).filter((n): n is string => !!n);
		this.problem(first.token, `Unable to resolve table or alias '${first.name}'`, similar(first.name, names));
	}
}

function createdTables(text: string): Set<string> {
	const names = new Set<string>();
	const pattern = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp|temporary|unlogged)?\s*(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(?:[\w$"`]+\.)?["`]?([\w$]+)/gi;
	for (const match of text.matchAll(pattern)) {
		names.add(match[1].toLowerCase());
	}
	return names;
}

export function analyzeDocument(catalog: Catalog, text: string, flavor: Flavor): Semantics {
	const created = createdTables(text);
	const result: Semantics = { symbols: [], problems: [] };
	for (const statement of splitStatements(text, flavor)) {
		const found = new Analyzer(catalog, statement.text, statement.start + text.slice(statement.start).indexOf(statement.text), flavor, created).run();
		result.symbols.push(...found.symbols);
		result.problems.push(...found.problems);
	}
	result.symbols.sort((a, b) => a.start - b.start);
	return result;
}

export function expandStar(catalog: Catalog, text: string, offset: number, flavor: Flavor): { start: number; length: number; text: string } | undefined {
	const statement = splitStatements(text, flavor).find(s => offset >= s.start && offset <= s.end);
	if (!statement) {
		return undefined;
	}
	const start = statement.start + text.slice(statement.start).indexOf(statement.text);
	return new Analyzer(catalog, statement.text, start, flavor, createdTables(text)).expand(offset - start);
}
