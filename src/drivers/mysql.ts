import { createPool } from 'mysql2/promise';
import type { FieldPacket, Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { connect, isIP } from 'node:net';
import tls from 'node:tls';
import type { Catalog, ColumnInfo, ObjectInfo, SchemaInfo, TableInfo, TableRef } from '../catalog';
import type { Change, Value } from '../shared/protocol';
import type { ConnectionConfig } from './connection';
import { RESULT_ROW_LIMIT } from './driver';
import type { CursorPage, CursorRequest, Driver, ExecuteResult, ResultColumn, SelectRequest, SelectResult } from './driver';
import { mysql as dialect, parenthesized, preview, selectClauses, statement, tableName } from './sql';
import { secureOptions } from './tls';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const GENERATED = /auto_increment|(virtual|stored|persistent) generated/i;
const TYPE_NAMES: Record<number, string> = {
	0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint',
	10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum',
	248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
};
const NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);

const SCHEMAS = `
	SELECT SCHEMA_NAME AS name
	FROM information_schema.SCHEMATA
	WHERE SCHEMA_NAME NOT IN (?)
	ORDER BY SCHEMA_NAME`;

const TABLES = `
	SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS name, TABLE_TYPE AS type
	FROM information_schema.TABLES
	WHERE TABLE_SCHEMA IN (?)`;

const COLUMNS = `
	SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, COLUMN_NAME AS name, COLUMN_TYPE AS type,
		IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value, EXTRA AS extra
	FROM information_schema.COLUMNS
	WHERE TABLE_SCHEMA IN (?)
	ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;

const CONSTRAINTS = `
	SELECT tc.TABLE_SCHEMA AS schema_name, tc.TABLE_NAME AS table_name, tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type,
		k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table,
		k.REFERENCED_COLUMN_NAME AS ref_column
	FROM information_schema.TABLE_CONSTRAINTS tc
	JOIN information_schema.KEY_COLUMN_USAGE k
		ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
		AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME
	WHERE tc.TABLE_SCHEMA IN (?) AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
	ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

const INDEXES = `
	SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
		COLUMN_NAME AS column_name
	FROM information_schema.STATISTICS
	WHERE TABLE_SCHEMA IN (?)
	ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

const ROUTINES = `
	SELECT ROUTINE_SCHEMA AS schema_name, ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns
	FROM information_schema.ROUTINES
	WHERE ROUTINE_SCHEMA IN (?)
	ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`;

const PARAMETERS = `
	SELECT SPECIFIC_SCHEMA AS schema_name, SPECIFIC_NAME AS name, ROUTINE_TYPE AS type, PARAMETER_MODE AS mode,
		PARAMETER_NAME AS parameter, DTD_IDENTIFIER AS data_type
	FROM information_schema.PARAMETERS
	WHERE SPECIFIC_SCHEMA IN (?) AND ORDINAL_POSITION > 0
	ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`;

const TRIGGERS = `
	SELECT TRIGGER_SCHEMA AS schema_name, TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS table_name,
		ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
	FROM information_schema.TRIGGERS
	WHERE TRIGGER_SCHEMA IN (?)
	ORDER BY TRIGGER_SCHEMA, EVENT_OBJECT_TABLE, TRIGGER_NAME`;

const CHECKS = [`
	SELECT CONSTRAINT_SCHEMA AS schema_name, TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause
	FROM information_schema.CHECK_CONSTRAINTS
	WHERE CONSTRAINT_SCHEMA IN (?)
	ORDER BY 1, 2, 3`, `
	SELECT tc.TABLE_SCHEMA AS schema_name, tc.TABLE_NAME AS table_name, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
	FROM information_schema.TABLE_CONSTRAINTS tc
	JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
	WHERE tc.TABLE_SCHEMA IN (?) AND tc.CONSTRAINT_TYPE = 'CHECK'
	ORDER BY 1, 2, 3`];

interface RoutineRow extends RowDataPacket { schema_name: string; name: string; type: string; returns: string | null }
interface ParameterRow extends RowDataPacket { schema_name: string; name: string; type: string; mode: string | null; parameter: string | null; data_type: string }
interface TriggerRow extends RowDataPacket { schema_name: string; name: string; table_name: string; timing: string; event: string }
interface CheckRow extends RowDataPacket { schema_name: string; table_name: string; name: string; clause: string }
interface TableRow extends RowDataPacket { schema_name: string; name: string; type: string }
interface ColumnRow extends RowDataPacket { schema_name: string; table_name: string; name: string; type: string; nullable: string; default_value: string | null; extra: string }
interface ConstraintRow extends RowDataPacket { schema_name: string; table_name: string; name: string; type: string; column_name: string; ref_schema: string | null; ref_table: string | null; ref_column: string | null }
interface IndexRow extends RowDataPacket { schema_name: string; table_name: string; name: string; non_unique: number | string; column_name: string | null }
interface CountRow extends RowDataPacket { count: number | string }

function cell(value: unknown): Value {
	if (Buffer.isBuffer(value)) {
		return `0x${value.toString('hex').toUpperCase()}`;
	}
	return value as Value;
}

const ADDRESSES = new Map<string, string>();
const checkIdentity = tls.checkServerIdentity;
tls.checkServerIdentity = (host, cert) => checkIdentity(ADDRESSES.get(host) ?? host, cert);

function verifiedName(address: string): string {
	if (!isIP(address)) {
		return address;
	}
	const name = `${address.replace(/[.:]/g, '-')}.address.invalid`;
	ADDRESSES.set(name, address);
	return name;
}

export class MysqlDriver implements Driver {
	readonly flavor = 'mysql';
	private readonly pool: Pool;
	private readonly sessions = new Map<string, PoolConnection>();
	private readonly running = new Map<string, PoolConnection>();
	private readonly cursors = new Map<string, { connection: PoolConnection; own: boolean; rows: AsyncIterator<unknown[]>; buffered: unknown[][]; done: boolean }>();
	private cursorCount = 0;

	constructor(private readonly config: ConnectionConfig) {
		const secure = secureOptions(config);
		const host = config.ssl === 'verify-full' ? verifiedName(config.servername ?? config.host) : config.host;
		this.pool = createPool({
			host,
			port: config.port,
			...(host !== config.host ? { stream: () => connect(config.port, config.host) } : {}),
			user: config.user,
			password: config.password,
			database: config.database || undefined,
			ssl: secure ? { ...secure, verifyIdentity: config.ssl === 'verify-full' } : undefined,
			charset: 'utf8mb4',
			connectionLimit: 8,
			maxIdle: 4,
			idleTimeout: 60_000,
			connectTimeout: 15_000,
			dateStrings: true,
			supportBigNumbers: true,
			bigNumberStrings: true,
			jsonStrings: true,
			flags: ['-LOCAL_FILES'],
		});
	}

	async version(): Promise<string> {
		const [rows] = await this.pool.query<(RowDataPacket & { version: string })[]>('SELECT VERSION() AS version');
		const version = rows[0].version;
		return /mariadb/i.test(version) ? `MariaDB ${version.split('-')[0]}` : `MySQL ${version}`;
	}

	async catalog(): Promise<Catalog> {
		const names = this.config.database
			? [this.config.database]
			: (await this.pool.query<(RowDataPacket & { name: string })[]>(SCHEMAS, [SYSTEM_SCHEMAS]))[0].map(r => r.name);
		const schemas = new Map<string, SchemaInfo>(names.map(name => [name, { name, tables: [], objects: [] }]));
		if (!names.length) {
			return { databases: [{ name: '', schemas: [] }], schemasOnly: true };
		}
		const [[tables], [columns], [constraints], [indexes], [routines], [parameters], [triggers], checks] = await Promise.all([
			this.pool.query<TableRow[]>(TABLES, [names]),
			this.pool.query<ColumnRow[]>(COLUMNS, [names]),
			this.pool.query<ConstraintRow[]>(CONSTRAINTS, [names]),
			this.pool.query<IndexRow[]>(INDEXES, [names]),
			this.pool.query<RoutineRow[]>(ROUTINES, [names]),
			this.pool.query<ParameterRow[]>(PARAMETERS, [names]),
			this.pool.query<TriggerRow[]>(TRIGGERS, [names]),
			this.checks(names),
		]);

		const byName = new Map<string, TableInfo>();
		const key = (schema: string, table: string): string => `${schema}\u0000${table}`;
		for (const row of tables) {
			if (row.type === 'SEQUENCE') {
				schemas.get(row.schema_name)?.objects?.push({ type: 'sequence', name: row.name, schema: row.schema_name });
				continue;
			}
			const table: TableInfo = { name: row.name, kind: /VIEW/.test(row.type) ? 'view' : 'table', columns: [], keys: [], foreignKeys: [], indexes: [] };
			byName.set(key(row.schema_name, row.name), table);
			schemas.get(row.schema_name)?.tables.push(table);
		}
		for (const row of columns) {
			const column: ColumnInfo = {
				name: row.name,
				type: row.type,
				nullable: row.nullable === 'YES',
				generated: GENERATED.test(row.extra),
			};
			if (row.default_value !== null && row.default_value !== 'NULL') {
				column.default = row.default_value;
			}
			byName.get(key(row.schema_name, row.table_name))?.columns.push(column);
		}
		for (const row of constraints) {
			const table = byName.get(key(row.schema_name, row.table_name));
			if (!table) {
				continue;
			}
			if (row.type === 'FOREIGN KEY') {
				let foreignKey = table.foreignKeys.find(f => f.name === row.name);
				if (!foreignKey) {
					const refTable = row.ref_schema === row.schema_name ? row.ref_table ?? '' : `${row.ref_schema}.${row.ref_table}`;
					foreignKey = { name: row.name, columns: [], refTable, refColumns: [] };
					table.foreignKeys.push(foreignKey);
				}
				foreignKey.columns.push(row.column_name);
				foreignKey.refColumns.push(row.ref_column ?? '');
			} else {
				let constraint = table.keys.find(k => k.name === row.name);
				if (!constraint) {
					constraint = { name: row.name, columns: [], primary: row.type === 'PRIMARY KEY' };
					table.keys.push(constraint);
				}
				constraint.columns.push(row.column_name);
			}
		}
		for (const row of indexes) {
			const table = byName.get(key(row.schema_name, row.table_name));
			if (!table) {
				continue;
			}
			let index = table.indexes.find(i => i.name === row.name);
			if (!index) {
				index = { name: row.name, columns: [], unique: Number(row.non_unique) === 0 };
				table.indexes.push(index);
			}
			index.columns.push(row.column_name ?? '(expression)');
		}
		for (const row of triggers) {
			const table = byName.get(key(row.schema_name, row.table_name));
			if (table) {
				table.triggers = [...table.triggers ?? [], { type: 'trigger', name: row.name, schema: row.schema_name, table: row.table_name, detail: `${row.timing} ${row.event}` }];
			}
		}
		for (const row of checks) {
			const table = byName.get(key(row.schema_name, row.table_name));
			if (table) {
				table.checks = [...table.checks ?? [], { type: 'check', name: row.name, schema: row.schema_name, table: row.table_name, detail: parenthesized(row.clause) }];
			}
		}
		const argumentsOf = new Map<string, string[]>();
		for (const row of parameters) {
			const id = key(row.schema_name, `${row.type}:${row.name}`);
			argumentsOf.set(id, [...argumentsOf.get(id) ?? [], [row.type === 'PROCEDURE' ? row.mode : '', row.parameter, row.data_type].filter(Boolean).join(' ')]);
		}
		for (const row of routines) {
			const args = argumentsOf.get(key(row.schema_name, `${row.type}:${row.name}`)) ?? [];
			const procedure = row.type === 'PROCEDURE';
			schemas.get(row.schema_name)?.objects?.push({
				type: procedure ? 'procedure' : 'function',
				name: row.name,
				schema: row.schema_name,
				detail: `(${args.join(', ')})${procedure || !row.returns ? '' : ` → ${row.returns}`}`,
			});
		}
		return { databases: [{ name: '', schemas: [...schemas.values()] }], schemasOnly: true };
	}

	private async checks(names: string[]): Promise<CheckRow[]> {
		for (const sql of CHECKS) {
			try {
				return (await this.pool.query<CheckRow[]>(sql, [names]))[0];
			} catch {
				continue;
			}
		}
		return [];
	}

	async select(request: SelectRequest): Promise<SelectResult> {
		const limit = Math.max(0, Math.floor(request.limit));
		const offset = Math.max(0, Math.floor(request.offset));
		const [result] = await this.withConnection(request.session, connection => connection.query<RowDataPacket[]>({
			sql: `SELECT * FROM ${tableName(dialect, request.table)} ${selectClauses(request.where, request.orderBy)} LIMIT ? OFFSET ?`,
			rowsAsArray: true,
		}, [limit + 1, offset]));
		const all = result as unknown as unknown[][];
		const more = all.length > limit;
		const rows = all.slice(0, limit).map(row => row.map(cell));
		return { rows, more, total: offset === 0 && !more ? rows.length : undefined };
	}

	async openCursor(request: CursorRequest): Promise<string> {
		const pinned = request.session ? this.sessions.get(request.session) : undefined;
		const connection = pinned ?? await this.pool.getConnection();
		const core = (connection as unknown as { connection: { query(options: object): { stream(options: object): AsyncIterable<unknown[]> } } }).connection;
		const rows = core.query({ sql: `SELECT * FROM ${tableName(dialect, request.table)} ${selectClauses(request.where, request.orderBy)}`, rowsAsArray: true })
			.stream({ highWaterMark: 1000 })[Symbol.asyncIterator]();
		let first: IteratorResult<unknown[]>;
		try {
			first = await rows.next();
		} catch (err) {
			if (!pinned) {
				connection.release();
			}
			throw err;
		}
		const id = String(++this.cursorCount);
		this.cursors.set(id, { connection, own: !pinned, rows, buffered: first.done ? [] : [first.value], done: !!first.done });
		return id;
	}

	async fetchCursor(id: string, limit: number): Promise<CursorPage> {
		const cursor = this.cursors.get(id);
		if (!cursor) {
			throw new Error('The export cursor is closed');
		}
		const rows = cursor.buffered.splice(0, limit);
		while (rows.length < limit && !cursor.done) {
			const step = await cursor.rows.next();
			if (step.done) {
				cursor.done = true;
			} else {
				rows.push(step.value);
			}
		}
		return { rows: rows.map(row => row.map(cell)), done: cursor.done && !cursor.buffered.length };
	}

	async closeCursor(id: string): Promise<void> {
		const cursor = this.cursors.get(id);
		if (!cursor) {
			return;
		}
		this.cursors.delete(id);
		if (cursor.done) {
			if (cursor.own) {
				cursor.connection.release();
			}
		} else if (cursor.own) {
			cursor.connection.destroy();
		} else {
			while (!(await cursor.rows.next()).done) {
				continue;
			}
		}
	}

	async count(table: TableRef, where: string, session?: string): Promise<number> {
		const [rows] = await this.withConnection(session, connection => connection.query<CountRow[]>(`SELECT COUNT(*) AS count FROM ${tableName(dialect, table)} ${selectClauses(where, '')}`));
		return Number(rows[0].count);
	}

	async apply(table: TableRef, changes: Change[], session?: string): Promise<void> {
		const name = tableName(dialect, table);
		const open = session ? this.sessions.get(session) : undefined;
		const connection = open ?? await this.pool.getConnection();
		if (session && !open) {
			this.sessions.set(session, connection);
		}
		try {
			const exact = await this.hasPrimaryKey(connection, table);
			await connection.query(open ? 'SAVEPOINT columbus_submit' : 'START TRANSACTION');
			for (const change of changes) {
				const { sql, params, single } = statement(dialect, name, change, exact);
				const [result] = await connection.query<ResultSetHeader>(sql, params);
				if (single && result.affectedRows !== 1) {
					throw new Error(`${change.kind === 'update' ? 'Update' : 'Delete'} matched ${result.affectedRows} rows instead of 1, nothing was saved`);
				}
			}
			if (open) {
				await connection.query('RELEASE SAVEPOINT columbus_submit');
			} else if (!session) {
				await connection.commit();
			}
		} catch (err) {
			if (open) {
				await connection.query('ROLLBACK TO SAVEPOINT columbus_submit').catch(() => undefined);
			} else {
				await connection.rollback().catch(() => undefined);
				this.release(session);
			}
			throw err;
		} finally {
			if (!session) {
				connection.release();
			}
		}
	}

	async preview(table: TableRef, changes: Change[]): Promise<string> {
		return preview(dialect, tableName(dialect, table), changes, await this.hasPrimaryKey(this.pool, table));
	}

	async ddl(table: TableRef): Promise<string> {
		const [rows] = await this.pool.query<RowDataPacket[]>({ sql: `SHOW CREATE TABLE ${tableName(dialect, table)}`, rowsAsArray: true });
		const definition = String((rows as unknown as unknown[][])[0][1]);
		return `${definition.replace(/;$/, '')};\n`;
	}

	async definition(object: ObjectInfo): Promise<string> {
		const name = `${dialect.quote(object.schema ?? '')}.${dialect.quote(object.name)}`;
		const show = async (sql: string, column: string): Promise<string> => {
			const [rows] = await this.pool.query<RowDataPacket[]>(sql);
			const text = rows[0]?.[column] as string | null | undefined;
			if (!text) {
				throw new Error(`Not enough privileges to read the definition of ${object.name}`);
			}
			return `${text.trim().replace(/;$/, '')};\n`;
		};
		switch (object.type) {
			case 'function':
				return show(`SHOW CREATE FUNCTION ${name}`, 'Create Function');
			case 'procedure':
				return show(`SHOW CREATE PROCEDURE ${name}`, 'Create Procedure');
			case 'trigger':
				return show(`SHOW CREATE TRIGGER ${name}`, 'SQL Original Statement');
			case 'sequence':
				return show(`SHOW CREATE SEQUENCE ${name}`, 'Create Table');
			case 'check':
				return `ALTER TABLE ${tableName(dialect, { database: '', schema: object.schema ?? '', table: object.table ?? '' })}\n    ADD CONSTRAINT ${dialect.quote(object.name)} CHECK ${object.detail ?? ''};\n`;
			default:
				return object.definition ?? '';
		}
	}

	async execute(sql: string, session: string): Promise<ExecuteResult[]> {
		let connection = this.sessions.get(session);
		if (!connection) {
			connection = await this.pool.getConnection();
			this.sessions.set(session, connection);
		}
		const [result, fields] = await connection.query<RowDataPacket[] | ResultSetHeader>({ sql, rowsAsArray: true });
		if (!Array.isArray(result)) {
			return [{ kind: 'count', command: /^\s*(\w+)/.exec(sql)?.[1].toUpperCase() ?? '', affected: result.affectedRows }];
		}
		const rows = result as unknown as unknown[][];
		return [{
			kind: 'rows',
			columns: ((fields ?? []) as FieldPacket[]).map(f => {
				const type = f.columnType ?? f.type ?? -1;
				const column: ResultColumn = { name: f.name, type: TYPE_NAMES[type] ?? 'unknown', numeric: NUMERIC_TYPES.has(type) };
				const schema = f.db ?? f.schema;
				if (f.orgTable && f.orgName && schema) {
					column.origin = { schema, table: f.orgTable, column: f.orgName };
				}
				return column;
			}),
			rows: rows.slice(0, RESULT_ROW_LIMIT).map(row => row.map(cell)),
			truncated: rows.length > RESULT_ROW_LIMIT,
		}];
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
				cursor.connection.destroy();
			}
		}
		for (const session of [...this.sessions.keys()]) {
			void this.finish(session, 'ROLLBACK').catch(() => undefined);
		}
		void this.pool.end();
	}

	async cancel(key: string): Promise<boolean> {
		const connection = this.sessions.get(key) ?? this.running.get(key);
		if (!connection) {
			return false;
		}
		await this.pool.query('KILL QUERY ?', [connection.threadId]);
		return true;
	}

	disconnect(): void {
		this.dispose();
	}

	private async withConnection<T>(session: string | undefined, run: (connection: PoolConnection) => Promise<T>): Promise<T> {
		const pinned = session ? this.sessions.get(session) : undefined;
		if (pinned) {
			return run(pinned);
		}
		const connection = await this.pool.getConnection();
		if (session) {
			this.running.set(session, connection);
		}
		try {
			return await run(connection);
		} finally {
			if (session && this.running.get(session) === connection) {
				this.running.delete(session);
			}
			connection.release();
		}
	}

	private async hasPrimaryKey(db: Pool | PoolConnection, table: TableRef): Promise<boolean> {
		const [rows] = await db.query<CountRow[]>(
			`SELECT COUNT(*) AS count FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'PRIMARY KEY'`,
			[table.schema, table.table]
		);
		return Number(rows[0].count) > 0;
	}

	private async finish(session: string, command: 'COMMIT' | 'ROLLBACK'): Promise<void> {
		const connection = this.sessions.get(session);
		if (!connection) {
			return;
		}
		try {
			await connection.query(command);
		} finally {
			this.release(session);
		}
	}

	private release(session: string | undefined): void {
		const connection = session ? this.sessions.get(session) : undefined;
		if (session && connection) {
			this.sessions.delete(session);
			connection.destroy();
		}
	}
}

export function create(config: ConnectionConfig): Driver {
	return new MysqlDriver(config);
}
