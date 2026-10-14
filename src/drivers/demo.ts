import type { Catalog, ColumnInfo, ObjectInfo, TableInfo, TableRef } from '../catalog';
import type { Change, Row, Value } from '../shared/protocol';
import type { CursorPage, CursorRequest, Driver, ExecuteResult, SelectRequest, SelectResult } from './driver';
import { postgres, preview, tableName } from './sql';

const FIRST = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Victor', 'Walter', 'Zoe'];
const LAST = ['Smith', 'Johnson', 'Brown', 'Taylor', 'Miller', 'Wilson', 'Moore', 'Clark', 'Lewis', 'Walker'];
const STATUS = ['new', 'paid', 'shipped', 'cancelled'];
const INTEGER = /^(tiny|small|medium|big)?int/i;
const DECIMAL = /^decimal\(\d+,(\d+)\)/i;

const USERS: TableInfo = {
	name: 'users',
	kind: 'table',
	columns: [
		{ name: 'id', type: 'int unsigned', nullable: false, generated: true },
		{ name: 'email', type: 'varchar(255)', nullable: false },
		{ name: 'name', type: 'varchar(100)', nullable: true },
		{ name: 'balance', type: 'decimal(10,2)', nullable: false, default: '0.00' },
		{ name: 'is_active', type: 'tinyint(1)', nullable: false, default: '1' },
		{ name: 'meta', type: 'json', nullable: true },
		{ name: 'bio', type: 'text', nullable: true },
		{ name: 'created_at', type: 'datetime', nullable: false, default: 'CURRENT_TIMESTAMP' },
	],
	keys: [
		{ name: 'PRIMARY', columns: ['id'], primary: true },
		{ name: 'users_email_unique', columns: ['email'], primary: false },
	],
	foreignKeys: [],
	indexes: [{ name: 'users_email_unique', columns: ['email'], unique: true }],
};

const ORDERS: TableInfo = {
	name: 'orders',
	kind: 'table',
	columns: [
		{ name: 'id', type: 'int unsigned', nullable: false, generated: true },
		{ name: 'user_id', type: 'int unsigned', nullable: false },
		{ name: 'total', type: 'decimal(10,2)', nullable: false },
		{ name: 'status', type: 'varchar(20)', nullable: false, default: "'new'" },
		{ name: 'created_at', type: 'datetime', nullable: false, default: 'CURRENT_TIMESTAMP' },
	],
	keys: [{ name: 'PRIMARY', columns: ['id'], primary: true }],
	foreignKeys: [{ name: 'fk_orders_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
	indexes: [{ name: 'idx_orders_user', columns: ['user_id'], unique: false }],
};

const ACTIVE_USERS: TableInfo = {
	name: 'active_users',
	kind: 'view',
	columns: USERS.columns.slice(0, 3),
	keys: [],
	foreignKeys: [],
	indexes: [],
};

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function stamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace('T', ' ');
}

function hours(n: number): string {
	return stamp(new Date(Date.UTC(2025, 0, 1) + n * 3_600_000));
}

function users(count: number): Value[][] {
	const next = random(7);
	return Array.from({ length: count }, (_, i) => {
		const first = FIRST[Math.floor(next() * FIRST.length)];
		const last = LAST[Math.floor(next() * LAST.length)];
		const named = next() > 0.15;
		return [
			i + 1,
			`${first.toLowerCase()}.${last.toLowerCase()}${i + 1}@example.com`,
			named ? `${first} ${last}` : null,
			(Math.floor(next() * 1_000_000) / 100).toFixed(2),
			next() > 0.2 ? 1 : 0,
			next() > 0.5 ? JSON.stringify({ role: next() > 0.8 ? 'admin' : 'user', tags: [i % 3, i % 5] }) : null,
			next() > 0.6 ? `${first} has been a customer since ${2015 + (i % 10)}. `.repeat(1 + (i % 4)).trim() : null,
			hours(i * 7),
		];
	});
}

function orders(count: number, userCount: number): Value[][] {
	const next = random(11);
	return Array.from({ length: count }, (_, i) => [
		i + 1,
		1 + Math.floor(next() * userCount),
		(Math.floor(next() * 50_000) / 100).toFixed(2),
		STATUS[Math.floor(next() * STATUS.length)],
		hours(i * 3),
	]);
}

function compare(a: Value, b: Value, numeric: boolean): number {
	if (a === b) {
		return 0;
	}
	if (a === null) {
		return -1;
	}
	if (b === null) {
		return 1;
	}
	if (numeric) {
		return Number(a) - Number(b);
	}
	return String(a) < String(b) ? -1 : 1;
}

function coerce(value: Value, column: ColumnInfo): Value {
	if (value === null) {
		if (!column.nullable) {
			throw new Error(`Column '${column.name}' cannot be null`);
		}
		return null;
	}
	const decimal = DECIMAL.exec(column.type);
	if (decimal || INTEGER.test(column.type)) {
		const number = typeof value === 'string' ? Number(value.trim()) : Number(value);
		if ((typeof value === 'string' && !value.trim()) || !Number.isFinite(number)) {
			throw new Error(`Incorrect value '${value}' for column '${column.name}'`);
		}
		return decimal ? number.toFixed(Number(decimal[1])) : Math.trunc(number);
	}
	return String(value);
}

export class DemoDriver implements Driver {
	readonly flavor = 'postgres';
	private readonly data = new Map<string, Value[][]>();
	private readonly sessions = new Map<string, Map<string, Value[][]>>();

	constructor() {
		this.data.set('users', users(1200));
		this.data.set('orders', orders(3000, 1200));
	}

	async version(): Promise<string> {
		return 'Demo';
	}

	async catalog(): Promise<Catalog> {
		return {
			databases: [{ name: 'demo', schemas: [{ name: 'public', tables: [ORDERS, USERS, ACTIVE_USERS] }] }],
		};
	}

	async select(request: SelectRequest): Promise<SelectResult> {
		if (request.where.trim()) {
			throw new Error('The demo data source cannot filter rows: clear WHERE');
		}
		const info = this.info(request.table);
		const rows = this.rows(info, this.tables(request.session));
		const order = this.order(request.orderBy, info);
		const sorted = order.length
			? [...rows].sort((a, b) => {
				for (const { index, desc, numeric } of order) {
					const result = compare(a[index], b[index], numeric);
					if (result) {
						return desc ? -result : result;
					}
				}
				return 0;
			})
			: rows;
		return {
			rows: sorted.slice(request.offset, request.offset + request.limit).map(r => [...r]),
			more: request.offset + request.limit < rows.length,
			total: rows.length,
		};
	}

	async count(table: TableRef, where: string, session?: string): Promise<number> {
		return (await this.select({ table, where, orderBy: '', offset: 0, limit: 0, session })).total ?? 0;
	}

	async apply(table: TableRef, changes: Change[], session?: string): Promise<void> {
		const info = this.info(table);
		const target = session ? this.sessions.get(session) ?? new Map(this.data) : this.data;
		const stored = target.get(info.name);
		if (info.kind === 'view' || !stored) {
			throw new Error(`${info.name} is a view and cannot be edited`);
		}
		const rows = stored.map(r => [...r]);
		const index = (name: string): number => {
			const i = info.columns.findIndex(c => c.name === name);
			if (i < 0) {
				throw new Error(`Unknown column '${name}'`);
			}
			return i;
		};
		const find = (key: Row): number => {
			const i = rows.findIndex(r => Object.entries(key).every(([name, value]) => r[index(name)] === value));
			if (i < 0) {
				throw new Error(`Row ${JSON.stringify(key)} no longer exists`);
			}
			return i;
		};
		for (const change of changes) {
			if (change.kind === 'delete') {
				rows.splice(find(change.key), 1);
			} else if (change.kind === 'update') {
				const row = rows[find(change.key)];
				for (const [name, value] of Object.entries(change.values)) {
					row[index(name)] = coerce(value, info.columns[index(name)]);
				}
			} else {
				rows.push(info.columns.map((column, i) => {
					if (column.name in change.values) {
						return coerce(change.values[column.name], column);
					}
					if (column.generated) {
						return rows.reduce((max, r) => Math.max(max, Number(r[i])), 0) + 1;
					}
					if (column.default === 'CURRENT_TIMESTAMP') {
						return stamp(new Date());
					}
					if (column.default !== undefined) {
						return coerce(column.default.replace(/^'(.*)'$/, '$1'), column);
					}
					if (column.nullable) {
						return null;
					}
					throw new Error(`Field '${column.name}' doesn't have a default value`);
				}));
			}
		}
		target.set(info.name, rows);
		if (session) {
			this.sessions.set(session, target);
		}
	}

	async preview(table: TableRef, changes: Change[]): Promise<string> {
		const info = this.info(table);
		return preview(postgres, tableName(postgres, table), changes, info.keys.some(k => k.primary));
	}

	async definition(object: ObjectInfo): Promise<string> {
		return object.definition ?? '';
	}

	private readonly cursors = new Map<string, { rows: Value[][]; position: number }>();
	private cursorCount = 0;

	async openCursor(request: CursorRequest): Promise<string> {
		const { rows } = await this.select({ ...request, offset: 0, limit: Number.MAX_SAFE_INTEGER });
		const id = String(++this.cursorCount);
		this.cursors.set(id, { rows, position: 0 });
		return id;
	}

	async fetchCursor(id: string, limit: number): Promise<CursorPage> {
		const cursor = this.cursors.get(id);
		if (!cursor) {
			throw new Error('The export cursor is closed');
		}
		const rows = cursor.rows.slice(cursor.position, cursor.position + limit);
		cursor.position += rows.length;
		return { rows, done: cursor.position >= cursor.rows.length };
	}

	async closeCursor(id: string): Promise<void> {
		this.cursors.delete(id);
	}

	async ddl(table: TableRef): Promise<string> {
		const info = this.info(table);
		const name = tableName(postgres, table);
		if (info.kind === 'view') {
			return `CREATE VIEW ${name} AS\nSELECT ${info.columns.map(c => c.name).join(', ')} FROM users WHERE is_active = 1;\n`;
		}
		const quoted = (columns: string[]): string => columns.map(postgres.quote).join(', ');
		const lines = [
			...info.columns.map(c => `    ${[postgres.quote(c.name), c.type, c.default === undefined ? '' : `DEFAULT ${c.default}`, c.nullable ? '' : 'NOT NULL'].filter(Boolean).join(' ')}`),
			...info.keys.map(k => `    CONSTRAINT ${postgres.quote(k.name)} ${k.primary ? 'PRIMARY KEY' : 'UNIQUE'} (${quoted(k.columns)})`),
			...info.foreignKeys.map(f => `    CONSTRAINT ${postgres.quote(f.name)} FOREIGN KEY (${quoted(f.columns)}) REFERENCES ${f.refTable} (${quoted(f.refColumns)})`),
		];
		return `CREATE TABLE ${name}\n(\n${lines.join(',\n')}\n);\n`;
	}

	async execute(): Promise<ExecuteResult[]> {
		throw new Error('The demo data source cannot run SQL');
	}

	async commit(session: string): Promise<void> {
		for (const [name, rows] of this.sessions.get(session) ?? []) {
			this.data.set(name, rows);
		}
		this.sessions.delete(session);
	}

	async rollback(session: string): Promise<void> {
		this.sessions.delete(session);
	}

	async cancel(): Promise<boolean> {
		return false;
	}

	disconnect(): void { }

	dispose(): void { }

	private tables(session: string | undefined): Map<string, Value[][]> {
		return (session && this.sessions.get(session)) || this.data;
	}

	private info(ref: TableRef): TableInfo {
		const info = [USERS, ORDERS, ACTIVE_USERS].find(t => t.name === ref.table);
		if (!info) {
			throw new Error(`Table '${ref.table}' doesn't exist`);
		}
		return info;
	}

	private rows(info: TableInfo, tables: Map<string, Value[][]>): Value[][] {
		if (info.kind === 'view') {
			return (tables.get('users') ?? []).filter(r => r[4] === 1).map(r => r.slice(0, info.columns.length));
		}
		return tables.get(info.name) ?? [];
	}

	private order(orderBy: string, info: TableInfo): { index: number; desc: boolean; numeric: boolean }[] {
		return orderBy.split(',').map(s => s.trim()).filter(Boolean).map(part => {
			const match = /^[`"]?([\w$]+)[`"]?(?:\s+(asc|desc))?$/i.exec(part);
			if (!match) {
				throw new Error(`The demo data source cannot sort by '${part}'`);
			}
			const index = info.columns.findIndex(c => c.name === match[1]);
			if (index < 0) {
				throw new Error(`Unknown column '${match[1]}' in 'order clause'`);
			}
			const type = info.columns[index].type;
			return { index, desc: match[2]?.toLowerCase() === 'desc', numeric: INTEGER.test(type) || DECIMAL.test(type) };
		});
	}
}
