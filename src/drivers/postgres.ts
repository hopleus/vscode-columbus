import type { ConnectionOptions } from 'node:tls';
import { Pool } from 'pg';
import type { PoolClient, QueryArrayResult } from 'pg';
import type { Catalog, ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, KeyInfo, ObjectInfo, ObjectType, SchemaInfo, TableInfo, TableRef } from '../catalog';
import type { Change, Value } from '../shared/protocol';
import type { ConnectionConfig } from './connection';
import { RESULT_ROW_LIMIT } from './driver';
import type { ColumnOrigin, CursorPage, CursorRequest, Driver, ExecuteResult, ResultColumn, SelectRequest, SelectResult } from './driver';
import { postgres as dialect, preview, selectClauses, statement, tableName } from './sql';
import { identityOptions, secureOptions } from './tls';

const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'`;
const RELATION = `c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition`;
const BOOLEAN_TYPE = 16;
const TYPE_NAMES: Record<number, string> = {
	16: 'boolean', 17: 'bytea', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 26: 'oid', 114: 'json',
	700: 'real', 701: 'double precision', 1042: 'character', 1043: 'character varying', 1082: 'date', 1083: 'time',
	1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
};
const NUMERIC_TYPES = new Set([20, 21, 23, 26, 700, 701, 1700]);
const raw = { getTypeParser: () => (value: string) => value };

const SCHEMAS = `
	SELECT n.nspname AS name
	FROM pg_namespace n
	WHERE ${USER_SCHEMA}
	ORDER BY 1`;

const TABLES = `
	SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE ${RELATION} AND ${USER_SCHEMA}`;

const columnsQuery = (generated: string): string => `
	SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
		NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default",
		a.attidentity AS identity, ${generated} AS generated
	FROM pg_attribute a
	JOIN pg_class c ON c.oid = a.attrelid
	JOIN pg_namespace n ON n.oid = c.relnamespace
	LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
	WHERE a.attnum > 0 AND NOT a.attisdropped AND ${RELATION} AND ${USER_SCHEMA}
	ORDER BY a.attrelid, a.attnum`;

const CONSTRAINTS = `
	SELECT con.conrelid AS oid, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition,
		to_json(ARRAY(
			SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
			JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord
		)) AS columns,
		fn.nspname AS ref_schema, fc.relname AS ref_table,
		to_json(ARRAY(
			SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
			JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord
		)) AS ref_columns
	FROM pg_constraint con
	JOIN pg_class c ON c.oid = con.conrelid
	JOIN pg_namespace n ON n.oid = c.relnamespace
	LEFT JOIN pg_class fc ON fc.oid = con.confrelid
	LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
	WHERE con.contype IN ('p', 'u', 'f', 'c') AND ${USER_SCHEMA}
	ORDER BY con.conrelid, con.conname`;

const ROUTINES = `
	SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind,
		pg_get_function_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS result,
		quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || coalesce((
			SELECT string_agg(format_type(a.type, NULL), ', ' ORDER BY a.position) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(type, position)
		), '') || ')' AS signature
	FROM pg_proc p
	JOIN pg_namespace n ON n.oid = p.pronamespace
	WHERE ${USER_SCHEMA}
	ORDER BY 1, 2, 4`;

const SEQUENCES = `
	SELECT n.nspname AS schema, c.relname AS name, format_type(s.seqtypid, NULL) AS type,
		(SELECT quote_ident(tc.relname) || '.' || quote_ident(a.attname)
			FROM pg_depend d
			JOIN pg_class tc ON tc.oid = d.refobjid
			JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
			WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a' LIMIT 1) AS owner
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	JOIN pg_sequence s ON s.seqrelid = c.oid
	WHERE c.relkind = 'S' AND ${USER_SCHEMA}
		AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'i')
	ORDER BY 1, 2`;

const TYPES = `
	SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind,
		CASE t.typtype
			WHEN 'e' THEN (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
			WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
			WHEN 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid)
			ELSE (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
				FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
		END AS detail
	FROM pg_type t
	JOIN pg_namespace n ON n.oid = t.typnamespace
	WHERE ${USER_SCHEMA}
		AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
	ORDER BY 1, 2`;

const TRIGGERS = `
	SELECT t.tgrelid AS oid, t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition
	FROM pg_trigger t
	JOIN pg_class c ON c.oid = t.tgrelid
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE NOT t.tgisinternal AND ${USER_SCHEMA}
	ORDER BY t.tgrelid, t.tgname`;

const EXTENSIONS = `
	SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
	FROM pg_extension e
	JOIN pg_namespace n ON n.oid = e.extnamespace
	ORDER BY 1`;

const DATABASES = `
	SELECT datname AS name
	FROM pg_database
	WHERE datallowconn AND NOT datistemplate
	ORDER BY 1`;

const ROLES = `
	SELECT rolname AS name, rolcanlogin AS login, rolsuper AS superuser
	FROM pg_roles
	WHERE rolname !~ '^pg_'
	ORDER BY 1`;

const TABLESPACES = `
	SELECT spcname AS name, pg_tablespace_location(oid) AS location
	FROM pg_tablespace
	ORDER BY 1`;

const ROUTINE_TYPES: Record<string, ObjectType> = { f: 'function', w: 'function', p: 'procedure', a: 'aggregate' };
const TYPE_KINDS: Record<string, ObjectType> = { e: 'enum', d: 'domain', r: 'range', c: 'composite' };

interface RoutineRow { schema: string; name: string; kind: string; arguments: string; result: string | null; signature: string }
interface SequenceRow { schema: string; name: string; type: string; owner: string | null }
interface TypeRow { schema: string; name: string; kind: string; detail: string | null }
interface TriggerRow { oid: number; name: string; definition: string }

export function triggerEvents(definition: string): string {
	const match = /\bTRIGGER\s+.+?\s+(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s/is.exec(definition);
	return match ? `${match[1]} ${match[2]}`.replace(/\s+/g, ' ').toUpperCase() : '';
}

const INDEXES = `
	SELECT i.indrelid AS oid, ic.relname AS name, i.indisunique AS unique,
		to_json(ARRAY(
			SELECT pg_get_indexdef(i.indexrelid, k + 1, true) FROM generate_subscripts(i.indkey, 1) AS k ORDER BY k
		)) AS columns
	FROM pg_index i
	JOIN pg_class ic ON ic.oid = i.indexrelid
	JOIN pg_class c ON c.oid = i.indrelid
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE ${USER_SCHEMA}
	ORDER BY i.indrelid, ic.relname`;

interface TableRow { oid: number; schema: string; name: string; kind: string }
interface ColumnRow { oid: number; name: string; type: string; nullable: boolean; default: string | null; identity: string; generated: string }
interface ConstraintRow { oid: number; name: string; type: string; columns: string[]; ref_schema: string | null; ref_table: string | null; ref_columns: string[]; definition: string }
type DefinitionRow = Omit<ColumnRow, 'oid'>;
interface IndexRow { oid: number; name: string; unique: boolean; columns: string[] }

function columnDefinition(column: DefinitionRow): string {
	let value = '';
	if (column.identity === 'a' || column.identity === 'd') {
		value = `GENERATED ${column.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
	} else if (column.generated === 's' || column.generated === 'v') {
		value = `GENERATED ALWAYS AS (${column.default}) ${column.generated === 's' ? 'STORED' : 'VIRTUAL'}`;
	} else if (column.default !== null) {
		value = `DEFAULT ${column.default}`;
	}
	return [dialect.quote(column.name), column.type, value, column.nullable ? '' : 'NOT NULL'].filter(Boolean).join(' ');
}

function paging(request: SelectRequest): { limit: number; offset: number } {
	return { limit: Math.max(0, Math.floor(request.limit)), offset: Math.max(0, Math.floor(request.offset)) };
}

export class PostgresDriver implements Driver {
	readonly flavor = 'postgres';
	private readonly pools = new Map<string, Pool>();
	private readonly sessions = new Map<string, PoolClient>();
	private readonly sessionDatabases = new Map<string, string>();
	private readonly running = new Map<string, PoolClient>();
	private versionNumber: Promise<number> | undefined;
	private readonly cursors = new Map<string, { client: PoolClient; name: string; own: boolean }>();
	private cursorCount = 0;

	constructor(private readonly config: ConnectionConfig) { }

	private ssl(): ConnectionOptions | false {
		const secure = secureOptions(this.config);
		return secure ? { ...secure, ...identityOptions(this.config, this.config.servername ?? this.config.host) } : false;
	}

	private pool(name?: string): Pool {
		const database = name || this.config.database;
		let pool = this.pools.get(database);
		if (!pool) {
			pool = new Pool({
				host: this.config.host,
				port: this.config.port,
				database,
				user: this.config.user,
				password: this.config.password,
				ssl: this.ssl(),
				max: database === this.config.database ? 8 : 4,
				idleTimeoutMillis: 60_000,
				connectionTimeoutMillis: 15_000,
				application_name: 'Columbus',
			});
			pool.on('error', () => undefined);
			this.pools.set(database, pool);
		}
		return pool;
	}

	async version(): Promise<string> {
		const result = await this.pool().query<{ version: string }>(`SELECT current_setting('server_version') AS version`);
		return `PostgreSQL ${result.rows[0].version.split(' ')[0]}`;
	}

	async catalog(selected?: string[]): Promise<Catalog> {
		const available = (await this.pool().query<{ name: string }>(DATABASES)).rows.map(row => row.name);
		const chosen = (selected ?? []).filter(name => available.includes(name) || name === this.config.database);
		const names = chosen.length ? chosen : [this.config.database];
		const [server, ...databases] = await Promise.all([this.serverObjects(), ...names.map(name => this.databaseCatalog(name))]);
		return { databases, server, available: available.includes(this.config.database) ? available : [this.config.database, ...available] };
	}

	private async serverObjects(): Promise<ObjectInfo[]> {
		const [roles, tablespaces] = await Promise.all([
			this.pool().query<{ name: string; login: boolean; superuser: boolean }>(ROLES),
			this.pool().query<{ name: string; location: string }>(TABLESPACES),
		]);
		return [
			...roles.rows.map((row): ObjectInfo => ({ type: 'role', name: row.name, detail: [row.superuser ? 'superuser' : '', row.login ? 'login' : ''].filter(Boolean).join(', ') })),
			...tablespaces.rows.map((row): ObjectInfo => ({ type: 'tablespace', name: row.name, detail: row.location || 'built-in' })),
		];
	}

	private async databaseCatalog(database: string): Promise<DatabaseInfo> {
		const version = await this.serverVersion();
		const pool = this.pool(database);
		const [schemas, tables, columns, constraints, indexes, routines, sequences, types, triggers, extensions] = await Promise.all([
			pool.query<{ name: string }>(SCHEMAS),
			pool.query<TableRow>(TABLES),
			pool.query<ColumnRow>(columnsQuery(version >= 120000 ? 'a.attgenerated' : `''`)),
			pool.query<ConstraintRow>(CONSTRAINTS),
			pool.query<IndexRow>(INDEXES),
			pool.query<RoutineRow>(ROUTINES),
			pool.query<SequenceRow>(SEQUENCES),
			pool.query<TypeRow>(TYPES),
			pool.query<TriggerRow>(TRIGGERS),
			pool.query<{ name: string; version: string; schema: string }>(EXTENSIONS),
		]);
		const byOid = new Map<number, TableInfo & { schema: string }>();
		for (const row of tables.rows) {
			byOid.set(row.oid, {
				name: row.name,
				schema: row.schema,
				kind: row.kind === 'v' || row.kind === 'm' ? 'view' : 'table',
				...(row.kind === 'm' ? { materialized: true } : {}),
				...(row.kind === 'f' ? { foreign: true } : {}),
				columns: [],
				keys: [],
				foreignKeys: [],
				indexes: [],
			});
		}
		for (const row of columns.rows) {
			const column: ColumnInfo = {
				name: row.name,
				type: row.type,
				nullable: row.nullable,
				generated: !!row.identity || !!row.generated || /^nextval\(/.test(row.default ?? ''),
			};
			if (row.default !== null) {
				column.default = row.default;
			}
			byOid.get(row.oid)?.columns.push(column);
		}
		for (const row of constraints.rows) {
			const table = byOid.get(row.oid);
			if (!table) {
				continue;
			}
			if (row.type === 'c') {
				const check: ObjectInfo = { type: 'check', name: row.name, database, schema: table.schema, table: table.name, detail: row.definition.replace(/^CHECK\s*/, '') };
				table.checks = [...table.checks ?? [], check];
			} else if (row.type === 'f') {
				const refTable = row.ref_schema === table.schema ? row.ref_table ?? '' : `${row.ref_schema}.${row.ref_table}`;
				const foreignKey: ForeignKeyInfo = { name: row.name, columns: row.columns, refTable, refColumns: row.ref_columns };
				table.foreignKeys.push(foreignKey);
			} else {
				const key: KeyInfo = { name: row.name, columns: row.columns, primary: row.type === 'p' };
				table.keys.push(key);
			}
		}
		for (const row of indexes.rows) {
			const index: IndexInfo = { name: row.name, columns: row.columns, unique: row.unique };
			byOid.get(row.oid)?.indexes.push(index);
		}

		for (const row of triggers.rows) {
			const table = byOid.get(row.oid);
			if (table) {
				const trigger: ObjectInfo = { type: 'trigger', name: row.name, database, schema: table.schema, table: table.name, detail: triggerEvents(row.definition), definition: `${row.definition};\n` };
				table.triggers = [...table.triggers ?? [], trigger];
			}
		}

		const bySchema = new Map<string, SchemaInfo>(schemas.rows.map(row => [row.name, { name: row.name, tables: [], objects: [] }]));
		for (const { schema, ...table } of byOid.values()) {
			bySchema.get(schema)?.tables.push(table);
		}
		const add = (schema: string, object: ObjectInfo): void => {
			bySchema.get(schema)?.objects?.push(object);
		};
		for (const row of routines.rows) {
			const result = row.result ? ` → ${row.result}` : '';
			add(row.schema, { type: ROUTINE_TYPES[row.kind] ?? 'function', name: row.name, database, schema: row.schema, signature: row.signature, detail: `(${row.arguments})${row.kind === 'p' ? '' : result}` });
		}
		for (const row of sequences.rows) {
			add(row.schema, { type: 'sequence', name: row.name, database, schema: row.schema, detail: row.owner ? `${row.type} · ${row.owner}` : row.type });
		}
		for (const row of types.rows) {
			add(row.schema, { type: TYPE_KINDS[row.kind] ?? 'composite', name: row.name, database, schema: row.schema, detail: `${TYPE_KINDS[row.kind] ?? ''}${row.detail ? ` · ${row.detail}` : ''}` });
		}
		const objects = extensions.rows.map((row): ObjectInfo => ({ type: 'extension', name: row.name, database, schema: row.schema, detail: `${row.version} · ${row.schema}` }));
		return { name: database, schemas: [...bySchema.values()], objects };
	}

	async select(request: SelectRequest): Promise<SelectResult> {
		const { limit, offset } = paging(request);
		const result = await this.withClient(request.session, request.table.database, client => client.query<Value[]>({
			text: `SELECT * FROM ${tableName(dialect, request.table)} ${selectClauses(request.where, request.orderBy)} LIMIT $1 OFFSET $2`,
			values: [limit + 1, offset],
			rowMode: 'array',
			types: raw,
		}));
		const booleans = result.fields.map(f => f.dataTypeID === BOOLEAN_TYPE);
		const more = result.rows.length > limit;
		const rows = result.rows.slice(0, limit).map(row => row.map((value, i) => value !== null && booleans[i] ? value === 't' : value));
		return { rows, more, total: offset === 0 && !more ? rows.length : undefined };
	}

	async openCursor(request: CursorRequest): Promise<string> {
		const id = String(++this.cursorCount);
		const name = `columbus_export_${id}`;
		const declare = `DECLARE ${name} NO SCROLL CURSOR FOR SELECT * FROM ${tableName(dialect, request.table)} ${selectClauses(request.where, request.orderBy)}`;
		const pinned = request.session ? this.sessions.get(request.session) : undefined;
		if (pinned) {
			try {
				await pinned.query('SAVEPOINT columbus_cursor');
				await pinned.query(declare);
				await pinned.query('RELEASE SAVEPOINT columbus_cursor');
				this.cursors.set(id, { client: pinned, name, own: false });
				return id;
			} catch (err) {
				await pinned.query('ROLLBACK TO SAVEPOINT columbus_cursor').catch(() => undefined);
				if ((err as { code?: string }).code !== '25P01') {
					throw err;
				}
			}
		}
		const client = await this.pool(request.table.database).connect();
		try {
			await client.query('BEGIN READ ONLY');
			await client.query(declare);
		} catch (err) {
			await client.query('ROLLBACK').catch(() => undefined);
			client.release();
			throw err;
		}
		this.cursors.set(id, { client, name, own: true });
		return id;
	}

	async fetchCursor(id: string, limit: number): Promise<CursorPage> {
		const cursor = this.cursors.get(id);
		if (!cursor) {
			throw new Error('The export cursor is closed');
		}
		const count = Math.max(1, Math.floor(limit));
		const result = await cursor.client.query<Value[]>({ text: `FETCH ${count} FROM ${cursor.name}`, rowMode: 'array', types: raw });
		const booleans = result.fields.map(f => f.dataTypeID === BOOLEAN_TYPE);
		const rows = result.rows.map(row => row.map((value, i) => value !== null && booleans[i] ? value === 't' : value));
		return { rows, done: rows.length < count };
	}

	async closeCursor(id: string): Promise<void> {
		const cursor = this.cursors.get(id);
		if (!cursor) {
			return;
		}
		this.cursors.delete(id);
		if (cursor.own) {
			await cursor.client.query('ROLLBACK').catch(() => undefined);
			cursor.client.release();
		} else {
			await cursor.client.query(`CLOSE ${cursor.name}`).catch(() => undefined);
		}
	}

	async count(table: TableRef, where: string, session?: string): Promise<number> {
		const result = await this.withClient(session, table.database, client => client.query<{ count: string }>({
			text: `SELECT count(*) AS count FROM ${tableName(dialect, table)} ${selectClauses(where, '')}`,
			values: [],
		}));
		return Number(result.rows[0].count);
	}

	async apply(table: TableRef, changes: Change[], session?: string): Promise<void> {
		const name = tableName(dialect, table);
		const open = session ? this.sessions.get(session) : undefined;
		const client = open ?? await this.pool(table.database).connect();
		if (session && !open) {
			this.sessions.set(session, client);
		}
		try {
			const exact = await this.hasPrimaryKey(client, name);
			await client.query(open ? 'SAVEPOINT columbus_submit' : 'BEGIN');
			for (const change of changes) {
				const { sql, params, single } = statement(dialect, name, change, exact);
				const result = await client.query(sql, params);
				if (single && result.rowCount !== 1) {
					throw new Error(`${change.kind === 'update' ? 'Update' : 'Delete'} matched ${result.rowCount} rows instead of 1, nothing was saved`);
				}
			}
			if (open) {
				await client.query('RELEASE SAVEPOINT columbus_submit');
			} else if (!session) {
				await client.query('COMMIT');
			}
		} catch (err) {
			if (open) {
				await client.query('ROLLBACK TO SAVEPOINT columbus_submit').catch(() => undefined);
			} else {
				await client.query('ROLLBACK').catch(() => undefined);
				this.release(session);
			}
			throw err;
		} finally {
			if (!session) {
				client.release();
			}
		}
	}

	async preview(table: TableRef, changes: Change[]): Promise<string> {
		const name = tableName(dialect, table);
		return preview(dialect, name, changes, await this.hasPrimaryKey(this.pool(table.database), name));
	}

	async ddl(table: TableRef): Promise<string> {
		const name = tableName(dialect, table);
		const pool = this.pool(table.database);
		const relation = (await pool.query<{ oid: number; kind: string }>(`SELECT c.oid, c.relkind AS kind FROM pg_class c WHERE c.oid = $1::regclass`, [name])).rows[0];
		if (relation.kind === 'v' || relation.kind === 'm') {
			const view = (await pool.query<{ definition: string }>(`SELECT pg_get_viewdef($1::oid, true) AS definition`, [relation.oid])).rows[0];
			const definition = view.definition.trim().replace(/;$/, '');
			return `CREATE ${relation.kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${name} AS\n${definition};\n`;
		}
		const generated = await this.serverVersion() >= 120000 ? 'a.attgenerated' : `''`;
		const [columns, constraints, indexes] = await Promise.all([
			pool.query<DefinitionRow>(`
				SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
					pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity, ${generated} AS generated
				FROM pg_attribute a
				LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
				WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
				ORDER BY a.attnum`, [relation.oid]),
			pool.query<{ name: string; definition: string }>(`
				SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition
				FROM pg_constraint
				WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c', 'x')
				ORDER BY contype <> 'p', contype, conname`, [relation.oid]),
			pool.query<{ definition: string }>(`
				SELECT pg_get_indexdef(i.indexrelid) AS definition
				FROM pg_index i
				WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
				ORDER BY 1`, [relation.oid]),
		]);
		const lines = [
			...columns.rows.map(column => `    ${columnDefinition(column)}`),
			...constraints.rows.map(c => `    CONSTRAINT ${dialect.quote(c.name)} ${c.definition}`),
		];
		const statements = [`CREATE TABLE ${name}\n(\n${lines.join(',\n')}\n);`, ...indexes.rows.map(i => `${i.definition};`)];
		return `${statements.join('\n\n')}\n`;
	}

	async definition(object: ObjectInfo): Promise<string> {
		const name = (value: string): string => object.schema ? `${dialect.quote(object.schema)}.${dialect.quote(value)}` : dialect.quote(value);
		const one = async <T>(sql: string, params: unknown[]): Promise<T> => {
			const row = (await this.pool(object.database).query(sql, params)).rows[0] as T | undefined;
			if (!row) {
				throw new Error(`${object.name} no longer exists`);
			}
			return row;
		};
		const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
		switch (object.type) {
			case 'function':
			case 'procedure': {
				const row = await one<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [object.signature]);
				return `${row.definition.trim()};\n`;
			}
			case 'aggregate': {
				const row = await one<{ args: string; sfunc: string; stype: string; finalfunc: string | null; initcond: string | null }>(`
					SELECT pg_get_function_identity_arguments(a.aggfnoid) AS args, a.aggtransfn::regproc::text AS sfunc,
						format_type(a.aggtranstype, NULL) AS stype, NULLIF(a.aggfinalfn::regproc::text, '-') AS finalfunc, a.agginitval AS initcond
					FROM pg_aggregate a WHERE a.aggfnoid = $1::regprocedure`, [object.signature]);
				const options = [`SFUNC = ${row.sfunc}`, `STYPE = ${row.stype}`, row.finalfunc ? `FINALFUNC = ${row.finalfunc}` : '', row.initcond === null ? '' : `INITCOND = ${literal(row.initcond)}`];
				return `CREATE AGGREGATE ${name(object.name)}(${row.args})\n(\n    ${options.filter(Boolean).join(',\n    ')}\n);\n`;
			}
			case 'sequence': {
				const sequence = name(object.name);
				const row = await one<{ type: string; start: string; increment: string; min: string; max: string; cache: string; cycle: boolean; owner: string | null }>(`
					SELECT format_type(s.seqtypid, NULL) AS type, s.seqstart AS start, s.seqincrement AS increment, s.seqmin AS min, s.seqmax AS max,
						s.seqcache AS cache, s.seqcycle AS cycle,
						(SELECT quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' || quote_ident(a.attname)
							FROM pg_depend d
							JOIN pg_class tc ON tc.oid = d.refobjid
							JOIN pg_namespace tn ON tn.oid = tc.relnamespace
							JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
							WHERE d.objid = s.seqrelid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a' LIMIT 1) AS owner
					FROM pg_sequence s WHERE s.seqrelid = $1::regclass`, [sequence]);
				const lines = [`AS ${row.type}`, `INCREMENT BY ${row.increment}`, `MINVALUE ${row.min}`, `MAXVALUE ${row.max}`, `START WITH ${row.start}`, `CACHE ${row.cache}`, row.cycle ? 'CYCLE' : 'NO CYCLE'];
				return `CREATE SEQUENCE ${sequence}\n    ${lines.join('\n    ')};\n${row.owner ? `\nALTER SEQUENCE ${sequence} OWNED BY ${row.owner};\n` : ''}`;
			}
			case 'enum': {
				const row = await one<{ labels: string | null }>(`SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) AS labels FROM pg_enum WHERE enumtypid = $1::regtype`, [name(object.name)]);
				return `CREATE TYPE ${name(object.name)} AS ENUM (${row.labels ?? ''});\n`;
			}
			case 'composite': {
				const row = await one<{ fields: string | null }>(`
					SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), E',\n    ' ORDER BY a.attnum) AS fields
					FROM pg_type t JOIN pg_attribute a ON a.attrelid = t.typrelid
					WHERE t.oid = $1::regtype AND a.attnum > 0 AND NOT a.attisdropped`, [name(object.name)]);
				return `CREATE TYPE ${name(object.name)} AS\n(\n    ${row.fields ?? ''}\n);\n`;
			}
			case 'range': {
				const row = await one<{ subtype: string }>(`SELECT format_type(rngsubtype, NULL) AS subtype FROM pg_range WHERE rngtypid = $1::regtype`, [name(object.name)]);
				return `CREATE TYPE ${name(object.name)} AS RANGE (SUBTYPE = ${row.subtype});\n`;
			}
			case 'domain': {
				const row = await one<{ base: string; notnull: boolean; default: string | null; checks: string | null }>(`
					SELECT format_type(t.typbasetype, t.typtypmod) AS base, t.typnotnull AS notnull, t.typdefault AS default,
						(SELECT string_agg('CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid, true), E'\n    ' ORDER BY c.conname)
							FROM pg_constraint c WHERE c.contypid = t.oid AND c.contype = 'c') AS checks
					FROM pg_type t WHERE t.oid = $1::regtype`, [name(object.name)]);
				const lines = [row.default === null ? '' : `DEFAULT ${row.default}`, row.notnull ? 'NOT NULL' : '', row.checks ?? ''].filter(Boolean);
				return `CREATE DOMAIN ${name(object.name)} AS ${row.base}${lines.length ? `\n    ${lines.join('\n    ')}` : ''};\n`;
			}
			case 'trigger':
				return object.definition ?? '';
			case 'check':
				return `ALTER TABLE ${tableName(dialect, { database: '', schema: object.schema ?? '', table: object.table ?? '' })}\n    ADD CONSTRAINT ${dialect.quote(object.name)} CHECK ${object.detail ?? ''};\n`;
			case 'extension': {
				const row = await one<{ version: string; schema: string }>(`SELECT e.extversion AS version, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1`, [object.name]);
				return `CREATE EXTENSION IF NOT EXISTS ${dialect.quote(object.name)} WITH SCHEMA ${dialect.quote(row.schema)} VERSION ${literal(row.version)};\n`;
			}
			case 'role': {
				const row = await one<{
					superuser: boolean; inherit: boolean; createrole: boolean; createdb: boolean; login: boolean; replication: boolean; bypassrls: boolean;
					connlimit: number; validuntil: string | null; groups: string[] | null;
				}>(`
					SELECT r.rolsuper AS superuser, r.rolinherit AS inherit, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb, r.rolcanlogin AS login,
						r.rolreplication AS replication, r.rolbypassrls AS bypassrls, r.rolconnlimit AS connlimit, r.rolvaliduntil::text AS validuntil,
						to_json(ARRAY(SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid ORDER BY 1)) AS groups
					FROM pg_roles r WHERE r.rolname = $1`, [object.name]);
				const flag = (on: boolean, word: string): string => (on ? word : `NO${word}`);
				const options = [
					flag(row.login, 'LOGIN'), flag(row.superuser, 'SUPERUSER'), flag(row.createdb, 'CREATEDB'), flag(row.createrole, 'CREATEROLE'),
					flag(row.inherit, 'INHERIT'), flag(row.replication, 'REPLICATION'), flag(row.bypassrls, 'BYPASSRLS'),
					row.connlimit >= 0 ? `CONNECTION LIMIT ${row.connlimit}` : '', row.validuntil ? `VALID UNTIL ${literal(row.validuntil)}` : '',
				].filter(Boolean);
				const grants = (row.groups ?? []).map(group => `GRANT ${dialect.quote(group)} TO ${dialect.quote(object.name)};\n`).join('');
				return `CREATE ROLE ${dialect.quote(object.name)} WITH\n    ${options.join('\n    ')};\n${grants ? `\n${grants}` : ''}`;
			}
			case 'tablespace': {
				const row = await one<{ location: string; owner: string }>(`SELECT pg_tablespace_location(oid) AS location, pg_get_userbyid(spcowner) AS owner FROM pg_tablespace WHERE spcname = $1`, [object.name]);
				return row.location
					? `CREATE TABLESPACE ${dialect.quote(object.name)} OWNER ${dialect.quote(row.owner)} LOCATION ${literal(row.location)};\n`
					: `-- ${object.name} is created together with the cluster\n`;
			}
		}
	}

	async execute(sql: string, session: string, target?: string): Promise<ExecuteResult[]> {
		const database = target || this.config.database;
		let client = this.sessions.get(session);
		if (client && this.sessionDatabases.get(session) !== database) {
			await this.finish(session, 'ROLLBACK').catch(() => undefined);
			client = undefined;
		}
		if (!client) {
			client = await this.pool(database).connect();
			this.sessions.set(session, client);
			this.sessionDatabases.set(session, database);
		}
		const output: unknown = await client.query<Value[]>({ text: sql, rowMode: 'array', types: raw });
		const results = (Array.isArray(output) ? output : [output]) as QueryArrayResult<Value[]>[];
		const origins = await this.origins(client, results.flatMap(r => r.fields));
		return results.map((result): ExecuteResult => {
			if (!result.fields.length) {
				return { kind: 'count', command: result.command ?? '', affected: result.rowCount ?? 0 };
			}
			const booleans = result.fields.map(f => f.dataTypeID === BOOLEAN_TYPE);
			return {
				kind: 'rows',
				columns: result.fields.map(f => {
					const column: ResultColumn = { name: f.name, type: TYPE_NAMES[f.dataTypeID] ?? `oid ${f.dataTypeID}`, numeric: NUMERIC_TYPES.has(f.dataTypeID) };
					const origin = origins.get(`${f.tableID}:${f.columnID}`);
					if (origin) {
						column.origin = origin;
					}
					return column;
				}),
				rows: result.rows.slice(0, RESULT_ROW_LIMIT).map(row => row.map((value, i) => value !== null && booleans[i] ? value === 't' : value)),
				truncated: result.rows.length > RESULT_ROW_LIMIT,
			};
		});
	}

	private async origins(client: PoolClient, fields: readonly { tableID: number; columnID: number }[]): Promise<Map<string, ColumnOrigin>> {
		const tables = [...new Set(fields.filter(f => f.tableID).map(f => f.tableID))];
		const origins = new Map<string, ColumnOrigin>();
		if (!tables.length) {
			return origins;
		}
		const result = await client.query<{ table_id: number; column_id: number; schema: string; table: string; column: string }>(`
			SELECT a.attrelid::int AS table_id, a.attnum::int AS column_id, n.nspname AS schema, c.relname AS table, a.attname AS column
			FROM pg_attribute a
			JOIN pg_class c ON c.oid = a.attrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0`, [tables]);
		for (const row of result.rows) {
			origins.set(`${row.table_id}:${row.column_id}`, { schema: row.schema, table: row.table, column: row.column });
		}
		return origins;
	}

	async commit(session: string): Promise<void> {
		await this.finish(session, 'COMMIT');
	}

	async rollback(session: string): Promise<void> {
		await this.finish(session, 'ROLLBACK');
	}

	dispose(): void {
		for (const [id, cursor] of [...this.cursors]) {
			this.cursors.delete(id);
			if (cursor.own) {
				cursor.client.release(true);
			}
		}
		for (const session of [...this.sessions.keys()]) {
			void this.finish(session, 'ROLLBACK').catch(() => undefined);
		}
		for (const pool of this.pools.values()) {
			void pool.end();
		}
		this.pools.clear();
	}

	async cancel(key: string): Promise<boolean> {
		const client = (this.sessions.get(key) ?? this.running.get(key)) as (PoolClient & { processID?: number }) | undefined;
		if (!client?.processID) {
			return false;
		}
		const result = await this.pool().query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [client.processID]);
		return result.rows[0].cancelled;
	}

	disconnect(): void {
		this.dispose();
	}

	private async withClient<T>(session: string | undefined, database: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
		const pinned = session ? this.sessions.get(session) : undefined;
		if (pinned) {
			return run(pinned);
		}
		const client = await this.pool(database).connect();
		if (session) {
			this.running.set(session, client);
		}
		try {
			return await run(client);
		} finally {
			if (session && this.running.get(session) === client) {
				this.running.delete(session);
			}
			client.release();
		}
	}

	private async hasPrimaryKey(db: Pool | PoolClient, name: string): Promise<boolean> {
		const result = await db.query<{ exact: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p') AS exact`,
			[name]
		);
		return result.rows[0].exact;
	}

	private async finish(session: string, command: 'COMMIT' | 'ROLLBACK'): Promise<void> {
		const client = this.sessions.get(session);
		if (!client) {
			return;
		}
		try {
			await client.query(command);
		} finally {
			this.release(session);
		}
	}

	private release(session: string | undefined): void {
		const client = session ? this.sessions.get(session) : undefined;
		if (session && client) {
			this.sessions.delete(session);
			this.sessionDatabases.delete(session);
			client.release(true);
		}
	}

	private serverVersion(): Promise<number> {
		this.versionNumber ??= this.pool().query<{ version: number }>(`SELECT current_setting('server_version_num')::int AS version`).then(r => r.rows[0].version);
		this.versionNumber.catch(() => {
			this.versionNumber = undefined;
		});
		return this.versionNumber;
	}
}

export function create(config: ConnectionConfig): Driver {
	return new PostgresDriver(config);
}
