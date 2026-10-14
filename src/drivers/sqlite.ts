import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type * as Sqlite from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { Catalog, ColumnInfo, ForeignKeyInfo, IndexInfo, KeyInfo, ObjectInfo, SchemaInfo, TableInfo, TableRef } from '../catalog';
import type { Change, Value } from '../shared/protocol';
import { splitStatements } from '../shared/statements';
import type { ConnectionConfig } from './connection';
import { RESULT_ROW_LIMIT } from './driver';
import type { CursorPage, CursorRequest, Driver, ExecuteResult, ResultColumn, SelectRequest, SelectResult } from './driver';
import { preview, selectClauses, sqlite as dialect, statement, tableName } from './sql';

type Database = Sqlite.DatabaseSync;
type Statement = Sqlite.StatementSync;
type Input = null | number | bigint | string | Uint8Array;

interface ColumnRow { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }
interface IndexRow { name: string; unique: number; origin: string }
interface ForeignKeyRow { id: number; table: string; from: string; to: string | null }

const load = createRequire(__filename);
const MIN = BigInt(Number.MIN_SAFE_INTEGER);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const NUMERIC = /INT|REAL|FLOA|DOUB|NUM|DEC/i;
const LEADING = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const HOST_SESSION = 'host';
const HOST_IDLE = 60_000;

interface HostReply {
	id: number;
	result?: unknown;
	error?: string;
	transaction: boolean;
}

class SessionHost {
	private readonly child: ChildProcess;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private nextId = 0;
	private stopped: Error | undefined;
	private idle: NodeJS.Timeout | undefined;
	transaction = false;

	constructor(module: string, database: string, onExit: () => void) {
		this.child = fork(module, [], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COLUMBUS_SQLITE_SESSION: database },
			serialization: 'advanced',
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		this.child.on('message', (reply: HostReply) => {
			const waiting = this.pending.get(reply.id);
			this.pending.delete(reply.id);
			this.transaction = reply.transaction;
			if (reply.error !== undefined) {
				waiting?.reject(new Error(reply.error));
			} else {
				waiting?.resolve(reply.result);
			}
			if (!this.pending.size && !reply.transaction) {
				this.idle = setTimeout(() => this.stop(), HOST_IDLE);
				this.idle.unref();
			}
		});
		const exited = (reason: Error): void => {
			this.stopped ??= reason;
			for (const waiting of this.pending.values()) {
				waiting.reject(this.stopped);
			}
			this.pending.clear();
			onExit();
		};
		this.child.on('exit', (code, signal) => exited(new Error(`The SQLite session stopped (${signal ?? `exit code ${code}`})`)));
		this.child.on('error', exited);
	}

	call<T>(method: string, ...args: unknown[]): Promise<T> {
		clearTimeout(this.idle);
		if (this.stopped) {
			return Promise.reject(this.stopped);
		}
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.child.send({ id, method, args });
		});
	}

	stop(reason = new Error('The SQLite session was closed')): void {
		clearTimeout(this.idle);
		this.stopped ??= reason;
		this.child.kill('SIGKILL');
	}
}

function engine(): typeof Sqlite {
	let sqlite: typeof Sqlite | undefined;
	try {
		sqlite = load('node:sqlite') as typeof Sqlite;
	} catch {
		sqlite = undefined;
	}
	if (typeof sqlite?.StatementSync.prototype.setReturnArrays !== 'function') {
		throw new Error(`SQLite needs Node.js 22.16 or newer in VS Code, this one has ${process.versions.node}. Update VS Code.`);
	}
	return sqlite;
}

export function databasePath(path: string): string {
	return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function value(raw: unknown): Value {
	if (raw === null || raw === undefined) {
		return null;
	}
	if (typeof raw === 'bigint') {
		return raw >= MIN && raw <= MAX ? Number(raw) : raw.toString();
	}
	if (typeof raw === 'number' || typeof raw === 'string') {
		return raw;
	}
	if (raw instanceof Uint8Array) {
		return `\\x${Buffer.from(raw).toString('hex')}`;
	}
	return String(raw);
}

function quietly(run: () => void): void {
	try {
		run();
	} catch {
		return;
	}
}

function bind(raw: Value): Input {
	return typeof raw === 'boolean' ? Number(raw) : raw;
}

function read(prepared: Statement, params: Input[], limit: number): { rows: Value[][]; more: boolean } {
	prepared.setReadBigInts(true);
	prepared.setReturnArrays(true);
	const rows: Value[][] = [];
	let more = false;
	for (const row of prepared.iterate(...params) as Iterable<unknown[]>) {
		if (rows.length >= limit) {
			more = true;
			break;
		}
		rows.push(row.map(value));
	}
	return { rows, more };
}

function all<T>(db: Database, sql: string, ...params: Input[]): T[] {
	return db.prepare(sql).all(...params) as T[];
}

function triggerEvents(sql: string): string {
	const match = /\bTRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+(?:(BEFORE|AFTER|INSTEAD\s+OF)\s+)?(DELETE|INSERT|UPDATE(?:\s+OF\s+.+?)?)\s+ON\s/is.exec(sql);
	return match ? `${match[1] ?? 'BEFORE'} ${match[2]}`.replace(/\s+/g, ' ').toUpperCase() : '';
}

function command(sql: string): string {
	return /^\w+/.exec(sql.replace(LEADING, ''))?.[0].toUpperCase() ?? '';
}

function inferredType(rows: readonly Value[][], index: number): string {
	const sample = rows.find(row => row[index] !== null)?.[index];
	if (typeof sample === 'number') {
		return Number.isInteger(sample) ? 'integer' : 'real';
	}
	return sample === undefined ? '' : typeof sample === 'string' && sample.startsWith('\\x') ? 'blob' : 'text';
}

export class SqliteDriver implements Driver {
	readonly flavor = 'sqlite';
	private readonly path: string;
	private db: Database | undefined;
	private readonly sessions = new Map<string, Database>();
	private readonly cursors = new Map<string, Iterator<unknown[]>>();
	private readonly hostedCursors = new Map<string, { host: SessionHost; id: string }>();
	private readonly hosts = new Map<string, SessionHost>();
	private cursorCount = 0;

	constructor(private readonly config: ConnectionConfig, private readonly hostModule: string | null = __filename) {
		this.path = databasePath(config.database);
	}

	private host(session: string | undefined, create = false): SessionHost | undefined {
		if (!this.hostModule || !session) {
			return undefined;
		}
		let host = this.hosts.get(session);
		if (!host && create) {
			const created: SessionHost = new SessionHost(this.hostModule, this.config.database, () => {
				if (this.hosts.get(session) === created) {
					this.hosts.delete(session);
				}
			});
			host = created;
			this.hosts.set(session, host);
		}
		return host;
	}

	inTransaction(session: string): boolean {
		return this.sessions.get(session)?.isTransaction ?? false;
	}

	async version(): Promise<string> {
		const db = this.main();
		db.prepare('SELECT count(*) FROM sqlite_master').get();
		const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
		return `SQLite ${row.version}`;
	}

	async catalog(): Promise<Catalog> {
		const db = this.main();
		const schemas: SchemaInfo[] = [];
		for (const { name } of all<{ name: string }>(db, 'SELECT name FROM pragma_database_list ORDER BY seq')) {
			const tables = this.tables(db, name);
			if (name !== 'temp' || tables.length) {
				schemas.push({ name, tables });
			}
		}
		return { databases: [{ name: basename(this.path), schemas }], schemasOnly: true, current: 'main' };
	}

	private tables(db: Database, schema: string): TableInfo[] {
		const objects = all<{ type: string; name: string }>(
			db,
			`SELECT type, name FROM ${dialect.quote(schema)}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`
		);
		const triggers = new Map<string, ObjectInfo[]>();
		for (const row of all<{ name: string; table: string; sql: string }>(db, `SELECT name, tbl_name AS "table", sql FROM ${dialect.quote(schema)}.sqlite_master WHERE type = 'trigger' ORDER BY name`)) {
			const trigger: ObjectInfo = { type: 'trigger', name: row.name, schema, table: row.table, detail: triggerEvents(row.sql), definition: `${row.sql.trim().replace(/;$/, '')};\n` };
			triggers.set(row.table, [...triggers.get(row.table) ?? [], trigger]);
		}
		return objects.map(object => {
			const rows = all<ColumnRow>(db, 'SELECT * FROM pragma_table_xinfo(?, ?) ORDER BY cid', object.name, schema).filter(row => row.hidden !== 1);
			const primary = rows.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk);
			const rowid = primary.length === 1 && primary[0].type.toUpperCase() === 'INTEGER';
			const columns = rows.map(row => {
				const column: ColumnInfo = {
					name: row.name,
					type: row.type,
					nullable: !row.notnull && !(rowid && row.pk > 0),
					generated: row.hidden === 2 || row.hidden === 3 || (rowid && row.pk > 0),
				};
				if (row.dflt_value !== null) {
					column.default = row.dflt_value;
				}
				return column;
			});
			const keys: KeyInfo[] = primary.length ? [{ name: `${object.name}_pkey`, columns: primary.map(row => row.name), primary: true }] : [];
			const indexes: IndexInfo[] = [];
			for (const index of all<IndexRow>(db, 'SELECT * FROM pragma_index_list(?, ?) ORDER BY name', object.name, schema)) {
				const names = all<{ name: string | null }>(db, 'SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno', index.name, schema).map(row => row.name ?? '<expression>');
				indexes.push({ name: index.name, columns: names, unique: !!index.unique });
				if (index.origin === 'u') {
					keys.push({ name: index.name, columns: names, primary: false });
				}
			}
			const table: TableInfo = { name: object.name, kind: object.type === 'view' ? 'view' : 'table', columns, keys, foreignKeys: this.foreignKeys(db, schema, object.name), indexes };
			if (triggers.has(object.name)) {
				table.triggers = triggers.get(object.name);
			}
			return table;
		});
	}

	private foreignKeys(db: Database, schema: string, table: string): ForeignKeyInfo[] {
		const groups = new Map<number, ForeignKeyRow[]>();
		for (const row of all<ForeignKeyRow>(db, 'SELECT * FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', table, schema)) {
			groups.set(row.id, [...groups.get(row.id) ?? [], row]);
		}
		return [...groups.values()].map(rows => {
			const refTable = rows[0].table;
			const implicit = rows.some(row => row.to === null)
				? all<{ name: string }>(db, 'SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', refTable, schema).map(row => row.name)
				: [];
			const columns = rows.map(row => row.from);
			return { name: `${table}_${columns.join('_')}_fkey`, columns, refTable, refColumns: rows.map((row, i) => row.to ?? implicit[i] ?? '') };
		});
	}

	async select(request: SelectRequest): Promise<SelectResult> {
		const host = this.host(request.session);
		if (host) {
			return host.call('select', { ...request, session: HOST_SESSION });
		}
		const limit = Math.max(0, Math.floor(request.limit));
		const offset = Math.max(0, Math.floor(request.offset));
		const prepared = this.connection(request.session).prepare(
			`SELECT * FROM ${tableName(dialect, request.table)} ${selectClauses(request.where, request.orderBy)} LIMIT ? OFFSET ?`
		);
		const { rows, more } = read(prepared, [limit + 1, offset], limit);
		return { rows, more, total: offset === 0 && !more ? rows.length : undefined };
	}

	async openCursor(request: CursorRequest): Promise<string> {
		const host = this.host(request.session);
		if (host) {
			const id = String(++this.cursorCount);
			this.hostedCursors.set(id, { host, id: await host.call<string>('openCursor', { ...request, session: HOST_SESSION }) });
			return id;
		}
		const prepared = this.connection(request.session).prepare(`SELECT * FROM ${tableName(dialect, request.table)} ${selectClauses(request.where, request.orderBy)}`);
		prepared.setReadBigInts(true);
		prepared.setReturnArrays(true);
		const id = String(++this.cursorCount);
		this.cursors.set(id, prepared.iterate() as unknown as Iterator<unknown[]>);
		return id;
	}

	async fetchCursor(id: string, limit: number): Promise<CursorPage> {
		const hosted = this.hostedCursors.get(id);
		if (hosted) {
			return hosted.host.call('fetchCursor', hosted.id, limit);
		}
		const cursor = this.cursors.get(id);
		if (!cursor) {
			throw new Error('The export cursor is closed');
		}
		const rows: Value[][] = [];
		while (rows.length < limit) {
			const step = cursor.next();
			if (step.done) {
				return { rows, done: true };
			}
			rows.push(step.value.map(value));
		}
		return { rows, done: false };
	}

	async closeCursor(id: string): Promise<void> {
		const hosted = this.hostedCursors.get(id);
		this.hostedCursors.delete(id);
		await hosted?.host.call('closeCursor', hosted.id).catch(() => undefined);
		this.cursors.get(id)?.return?.();
		this.cursors.delete(id);
	}

	async count(table: TableRef, where: string, session?: string): Promise<number> {
		const host = this.host(session);
		if (host) {
			return host.call('count', table, where, HOST_SESSION);
		}
		const row = this.connection(session).prepare(`SELECT count(*) AS count FROM ${tableName(dialect, table)} ${selectClauses(where, '')}`).get() as { count: number };
		return Number(row.count);
	}

	async apply(table: TableRef, changes: Change[], session?: string): Promise<void> {
		const host = this.host(session, true);
		if (host) {
			return host.call('apply', table, changes, HOST_SESSION);
		}
		const db = this.connection(session);
		const name = tableName(dialect, table);
		const exact = this.hasPrimaryKey(db, table);
		const open = db.isTransaction;
		db.exec(open ? 'SAVEPOINT columbus_submit' : 'BEGIN');
		try {
			for (const change of changes) {
				const { sql, params, single } = statement(dialect, name, change, exact);
				const result = db.prepare(sql).run(...params.map(bind));
				if (single && Number(result.changes) !== 1) {
					throw new Error(`${change.kind === 'update' ? 'Update' : 'Delete'} matched ${Number(result.changes)} rows instead of 1, nothing was saved`);
				}
			}
			if (open) {
				db.exec('RELEASE SAVEPOINT columbus_submit');
			} else if (!session) {
				db.exec('COMMIT');
			}
		} catch (err) {
			quietly(() => db.exec(open ? 'ROLLBACK TO SAVEPOINT columbus_submit; RELEASE SAVEPOINT columbus_submit' : 'ROLLBACK'));
			throw err;
		}
	}

	async preview(table: TableRef, changes: Change[]): Promise<string> {
		return preview(dialect, tableName(dialect, table), changes, this.hasPrimaryKey(this.main(), table));
	}

	async ddl(table: TableRef): Promise<string> {
		const rows = all<{ sql: string }>(
			this.main(),
			`SELECT sql FROM ${dialect.quote(table.schema)}.sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type NOT IN ('table', 'view'), type, name`,
			table.table
		);
		return `${rows.map(row => `${row.sql.trim().replace(/;$/, '')};`).join('\n\n')}\n`;
	}

	async definition(object: ObjectInfo): Promise<string> {
		return object.definition ?? '';
	}

	async execute(sql: string, session: string): Promise<ExecuteResult[]> {
		const host = this.host(session, true);
		if (host) {
			return host.call('execute', sql, HOST_SESSION);
		}
		const db = this.session(session);
		const results: ExecuteResult[] = [];
		const totalChanges = db.prepare('SELECT total_changes() AS changes');
		for (const part of splitStatements(sql, 'sqlite')) {
			const prepared = db.prepare(part.text);
			const columns = prepared.columns();
			if (columns.length) {
				const { rows, more } = read(prepared, [], RESULT_ROW_LIMIT);
				results.push({
					kind: 'rows',
					columns: columns.map((column, i): ResultColumn => {
						const type = column.type ?? inferredType(rows, i);
						const result: ResultColumn = {
							name: column.name,
							type: type.toLowerCase(),
							numeric: NUMERIC.test(type) || (rows.some(row => row[i] !== null) && rows.every(row => row[i] === null || typeof row[i] === 'number')),
						};
						if (column.table && column.column) {
							result.origin = { schema: column.database ?? 'main', table: column.table, column: column.column };
						}
						return result;
					}),
					rows,
					truncated: more,
				});
			} else {
				const before = Number((totalChanges.get() as { changes: number }).changes);
				prepared.run();
				const after = Number((totalChanges.get() as { changes: number }).changes);
				results.push({ kind: 'count', command: command(part.text), affected: after - before });
			}
		}
		return results;
	}

	async commit(session: string): Promise<void> {
		const host = this.host(session);
		await (host ? host.call('commit', HOST_SESSION) : this.finish(session, 'COMMIT'));
	}

	async rollback(session: string): Promise<void> {
		const host = this.host(session);
		await (host ? host.call('rollback', HOST_SESSION) : this.finish(session, 'ROLLBACK'));
	}

	async cancel(key: string): Promise<boolean> {
		const host = this.host(key);
		if (!host) {
			return false;
		}
		this.hosts.delete(key);
		host.stop(new Error(host.transaction ? 'Cancelled; the open transaction of this session was rolled back' : 'Cancelled'));
		return true;
	}

	disconnect(): void {
		this.dispose();
	}

	dispose(): void {
		for (const host of this.hosts.values()) {
			host.stop();
		}
		this.hosts.clear();
		this.hostedCursors.clear();
		for (const db of [...this.sessions.values(), this.db]) {
			quietly(() => db?.close());
		}
		this.sessions.clear();
		this.db = undefined;
	}

	private finish(session: string, sql: 'COMMIT' | 'ROLLBACK'): void {
		const db = this.sessions.get(session);
		if (!db) {
			return;
		}
		try {
			if (db.isTransaction) {
				db.exec(sql);
			}
		} finally {
			this.sessions.delete(session);
			quietly(() => db.close());
		}
	}

	private hasPrimaryKey(db: Database, table: TableRef): boolean {
		const row = db.prepare('SELECT count(*) AS count FROM pragma_table_info(?, ?) WHERE pk > 0').get(table.table, table.schema) as { count: number };
		return Number(row.count) > 0;
	}

	private connection(session: string | undefined): Database {
		return session && !this.hostModule ? this.session(session) : this.main();
	}

	private main(): Database {
		this.db ??= this.open();
		return this.db;
	}

	private session(key: string): Database {
		let db = this.sessions.get(key);
		if (!db) {
			db = this.open();
			this.sessions.set(key, db);
		}
		return db;
	}

	private open(): Database {
		const sqlite = engine();
		if (!existsSync(this.path)) {
			throw new Error(`Database file not found: ${this.path}`);
		}
		const db = new sqlite.DatabaseSync(this.path);
		db.exec('PRAGMA busy_timeout = 5000');
		return db;
	}
}

export function create(config: ConnectionConfig): Driver {
	return new SqliteDriver(config);
}

function serve(database: string): void {
	const driver = new SqliteDriver({ driver: 'sqlite', host: '', port: 0, database, user: '', password: '', ssl: 'disable' }, null);
	const methods = driver as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
	process.on('message', (request: { id: number; method: string; args: unknown[] }) => {
		void methods[request.method](...request.args).then(
			result => process.send?.({ id: request.id, result, transaction: driver.inTransaction(HOST_SESSION) }),
			(err: Error) => process.send?.({ id: request.id, error: err.message, transaction: driver.inTransaction(HOST_SESSION) }),
		);
	});
	process.on('disconnect', () => process.exit(0));
	new Worker('const { workerData } = require("node:worker_threads"); setInterval(() => { if (process.ppid !== workerData) process.kill(process.pid, "SIGKILL"); }, 1000);', { eval: true, workerData: process.ppid }).unref();
}

if (process.env.COLUMBUS_SQLITE_SESSION && process.send) {
	serve(process.env.COLUMBUS_SQLITE_SESSION);
}
