import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import type { TableInfo } from '../catalog';
import { parseUrl } from '../drivers/connection';
import { PostgresDriver } from '../drivers/postgres';
import { RemoteDriver } from '../drivers/remote';

const url = process.env.COLUMBUS_PG_URL;
const skip = url ? false : 'COLUMBUS_PG_URL is not set';
const config = url ? parseUrl('postgres', url) : undefined;
const schema = 'columbus_test';
const ref = (table: string) => ({ database: config?.database ?? '', schema, table });

const SETUP = `
	DROP SCHEMA IF EXISTS ${schema} CASCADE;
	CREATE SCHEMA ${schema};
	CREATE TABLE ${schema}.users (
		id serial PRIMARY KEY,
		email text NOT NULL UNIQUE,
		name varchar(100),
		balance numeric(10,2) NOT NULL DEFAULT 0,
		active boolean NOT NULL DEFAULT true,
		meta jsonb,
		created_at timestamptz NOT NULL DEFAULT now()
	);
	CREATE TABLE ${schema}.orders (
		id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		user_id integer NOT NULL REFERENCES ${schema}.users (id),
		total numeric(10,2) NOT NULL
	);
	CREATE INDEX orders_user_idx ON ${schema}.orders (user_id);
	CREATE TABLE ${schema}.notes (body text, meta json);
	CREATE VIEW ${schema}.active_users AS SELECT id, email FROM ${schema}.users WHERE active;
	CREATE MATERIALIZED VIEW ${schema}.user_totals AS SELECT user_id, sum(total) AS total FROM ${schema}.orders GROUP BY user_id;
	INSERT INTO ${schema}.users (email, name, balance, active, meta)
		SELECT 'user' || i || '@example.com', CASE WHEN i % 5 = 0 THEN NULL ELSE 'User ' || i END, i * 1.5, i % 3 <> 0, CASE WHEN i % 2 = 0 THEN '{"n": 1}'::jsonb END
		FROM generate_series(1, 30) AS i;
	INSERT INTO ${schema}.orders (user_id, total) VALUES (1, 10), (1, 20), (2, 30);
	INSERT INTO ${schema}.notes VALUES ('first', '{"a": 1}'), ('second', NULL);
	CREATE TYPE ${schema}.mood AS ENUM ('sad', 'ok', 'happy');
	CREATE DOMAIN ${schema}.positive AS numeric CHECK (VALUE > 0);
	CREATE TYPE ${schema}.pair AS (a integer, b text);
	CREATE SEQUENCE ${schema}.invoice_seq START 100;
	CREATE FUNCTION ${schema}.total_of(uid integer) RETURNS numeric LANGUAGE sql AS $$ SELECT sum(total) FROM ${schema}.orders WHERE user_id = uid $$;
	CREATE PROCEDURE ${schema}.touch() LANGUAGE sql AS $$ SELECT 1 $$;
	CREATE FUNCTION ${schema}.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
	ALTER TABLE ${schema}.orders ADD CONSTRAINT orders_total_check CHECK (total >= 0);
	CREATE TRIGGER orders_stamp BEFORE INSERT OR UPDATE ON ${schema}.orders FOR EACH ROW EXECUTE FUNCTION ${schema}.stamp();
`;

let driver: PostgresDriver | undefined;

async function run(sql: string, database?: string): Promise<void> {
	if (!config) {
		return;
	}
	const client = new Client({ ...config, ...(database ? { database } : {}), ssl: false });
	await client.connect();
	try {
		await client.query(sql);
	} finally {
		await client.end();
	}
}

before(async () => {
	await run(SETUP);
	driver = config && new PostgresDriver(config);
});

after(async () => {
	driver?.dispose();
	await run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

function pg(): PostgresDriver {
	assert.ok(driver);
	return driver;
}

async function table(name: string): Promise<TableInfo> {
	const catalog = await pg().catalog();
	const found = catalog.databases[0].schemas.find(s => s.name === schema)?.tables.find(t => t.name === name);
	assert.ok(found, `${name} is in the catalog`);
	return found;
}

test('version names the server', { skip }, async () => {
	assert.match(await pg().version(), /^PostgreSQL \d+(\.\d+)?$/);
});

test('catalog reads columns, keys, foreign keys and indexes', { skip }, async () => {
	const users = await table('users');
	assert.equal(users.kind, 'table');
	assert.deepEqual(users.columns.map(c => [c.name, c.type, c.nullable, c.generated]), [
		['id', 'integer', false, true],
		['email', 'text', false, false],
		['name', 'character varying(100)', true, false],
		['balance', 'numeric(10,2)', false, false],
		['active', 'boolean', false, false],
		['meta', 'jsonb', true, false],
		['created_at', 'timestamp with time zone', false, false],
	]);
	assert.equal(users.columns[3].default, '0');
	assert.deepEqual(users.keys.map(k => [k.columns, k.primary]), [[['email'], false], [['id'], true]]);

	const orders = await table('orders');
	assert.equal(orders.columns[0].generated, true);
	assert.deepEqual(orders.foreignKeys.map(f => [f.columns, f.refTable, f.refColumns]), [[['user_id'], 'users', ['id']]]);
	assert.deepEqual(orders.indexes.map(i => [i.name, i.columns, i.unique]), [['orders_pkey', ['id'], true], ['orders_user_idx', ['user_id'], false]]);

	assert.equal((await table('active_users')).kind, 'view');
	assert.equal((await table('active_users')).materialized, undefined);
	const totals = await table('user_totals');
	assert.deepEqual([totals.kind, totals.materialized, totals.columns.map(c => c.name)], ['view', true, ['user_id', 'total']]);
	assert.match(await pg().ddl(ref('user_totals')), /^CREATE MATERIALIZED VIEW "columbus_test"\."user_totals" AS\n/);
});

test('catalog lists routines, sequences, types, checks, triggers and server objects', { skip }, async () => {
	const catalog = await pg().catalog();
	const objects = catalog.databases[0].schemas.find(s => s.name === schema)?.objects ?? [];
	assert.deepEqual(objects.map(o => `${o.type}:${o.name}:${o.detail}`), [
		'function:stamp:() → trigger',
		'function:total_of:(uid integer) → numeric',
		'procedure:touch:()',
		'sequence:invoice_seq:bigint',
		'sequence:users_id_seq:integer · users.id',
		'enum:mood:enum · \'sad\', \'ok\', \'happy\'',
		'composite:pair:composite · a integer, b text',
		'domain:positive:domain · numeric',
	]);
	const orders = await table('orders');
	assert.deepEqual(orders.checks?.map(c => [c.name, c.detail]), [['orders_total_check', '(total >= 0::numeric)']]);
	assert.deepEqual(orders.triggers?.map(t => [t.name, t.detail]), [['orders_stamp', 'BEFORE INSERT OR UPDATE']]);
	assert.ok(catalog.databases[0].objects?.some(o => o.type === 'extension' && o.name === 'plpgsql'));
	assert.ok(catalog.server?.some(o => o.type === 'role' && o.name === config?.user));
	assert.ok(catalog.server?.some(o => o.type === 'tablespace' && o.name === 'pg_default'));

	const find = (name: string) => objects.find(o => o.name === name)!;
	assert.match(await pg().definition(find('total_of')), /^CREATE OR REPLACE FUNCTION columbus_test\.total_of\(uid integer\)\n RETURNS numeric/);
	assert.match(await pg().definition(find('invoice_seq')), /^CREATE SEQUENCE "columbus_test"\."invoice_seq"\n {4}AS bigint\n {4}INCREMENT BY 1\n[\s\S]*START WITH 100\n/);
	assert.match(await pg().definition(find('users_id_seq')), /OWNED BY columbus_test\.users\.id;\n$/);
	assert.equal(await pg().definition(find('mood')), `CREATE TYPE "columbus_test"."mood" AS ENUM ('sad', 'ok', 'happy');\n`);
	assert.equal(await pg().definition(find('pair')), 'CREATE TYPE "columbus_test"."pair" AS\n(\n    a integer,\n    b text\n);\n');
	assert.match(await pg().definition(find('positive')), /^CREATE DOMAIN "columbus_test"\."positive" AS numeric\n {4}CONSTRAINT positive_check CHECK \(VALUE > 0::numeric\);\n$/);
	assert.match(await pg().definition(orders.triggers![0]), /^CREATE TRIGGER orders_stamp BEFORE INSERT OR UPDATE ON columbus_test\.orders/);
	assert.equal(await pg().definition(orders.checks![0]), 'ALTER TABLE "columbus_test"."orders"\n    ADD CONSTRAINT "orders_total_check" CHECK (total >= 0::numeric);\n');
	assert.match(await pg().definition({ type: 'extension', name: 'plpgsql' }), /^CREATE EXTENSION IF NOT EXISTS "plpgsql" WITH SCHEMA "pg_catalog" VERSION '/);
	assert.match(await pg().definition({ type: 'role', name: config?.user ?? '' }), /^CREATE ROLE "\w+" WITH\n {4}LOGIN\n/);
	assert.match(await pg().definition({ type: 'tablespace', name: 'pg_default' }), /^-- pg_default/);
});

test('select pages, filters, sorts and keeps values as text', { skip }, async () => {
	const page = await pg().select({ table: ref('users'), where: '', orderBy: 'id', offset: 0, limit: 10 });
	assert.equal(page.rows.length, 10);
	assert.equal(page.more, true);
	assert.equal(page.total, undefined);
	assert.deepEqual(page.rows[0].slice(0, 6), ['1', 'user1@example.com', 'User 1', '1.50', true, null]);
	assert.equal(page.rows[1][5], '{"n": 1}');
	assert.equal(page.rows[2][4], false);

	const filtered = await pg().select({ table: ref('users'), where: 'name IS NULL', orderBy: 'id DESC', offset: 0, limit: 10 });
	assert.deepEqual(filtered.rows.map(r => r[0]), ['30', '25', '20', '15', '10', '5']);
	assert.equal(filtered.more, false);
	assert.equal(filtered.total, 6);

	assert.equal(await pg().count(ref('users'), 'active'), 20);
	await assert.rejects(pg().select({ table: ref('users'), where: 'missing = 1', orderBy: '', offset: 0, limit: 1 }), /column "missing" does not exist/);
});

test('apply runs changes in one transaction', { skip }, async () => {
	await pg().apply(ref('users'), [
		{ kind: 'update', key: { id: '1' }, values: { name: 'Changed', active: false, balance: '99.5' } },
		{ kind: 'insert', values: { email: 'new@example.com' } },
		{ kind: 'delete', key: { id: '30' } },
	]);
	const rows = (await pg().select({ table: ref('users'), where: `id = 1 OR email = 'new@example.com'`, orderBy: 'id', offset: 0, limit: 10 })).rows;
	assert.deepEqual(rows.map(r => r.slice(1, 5)), [['user1@example.com', 'Changed', '99.50', false], ['new@example.com', null, '0.00', true]]);
	assert.equal(await pg().count(ref('users'), 'id = 30'), 0);

	await assert.rejects(pg().apply(ref('users'), [
		{ kind: 'update', key: { id: '2' }, values: { name: 'Lost' } },
		{ kind: 'insert', values: { name: 'No email' } },
	]), /null value in column "email"/);
	assert.equal((await pg().select({ table: ref('users'), where: 'id = 2', orderBy: '', offset: 0, limit: 1 })).rows[0][2], 'User 2');

	await assert.rejects(pg().apply(ref('users'), [{ kind: 'delete', key: { id: '999' } }]), /matched 0 rows/);
});

test('apply finds rows of tables without a primary key by every column', { skip }, async () => {
	await pg().apply(ref('notes'), [
		{ kind: 'update', key: { body: 'first', meta: '{"a": 1}' }, values: { body: 'updated' } },
		{ kind: 'delete', key: { body: 'second', meta: null } },
	]);
	const rows = (await pg().select({ table: ref('notes'), where: '', orderBy: '', offset: 0, limit: 10 })).rows;
	assert.deepEqual(rows, [['updated', '{"a": 1}']]);
});

test('ddl shows tables and views', { skip }, async () => {
	const ddl = await pg().ddl(ref('orders'));
	assert.match(ddl, /^CREATE TABLE "columbus_test"\."orders"\n\(\n {4}"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,/);
	assert.match(ddl, /CONSTRAINT "orders_user_id_fkey" FOREIGN KEY \(user_id\) REFERENCES columbus_test\.users\(id\)/);
	assert.match(ddl, /CREATE INDEX orders_user_idx ON columbus_test\.orders USING btree \(user_id\);/);
	assert.match(await pg().ddl(ref('active_users')), /^CREATE VIEW "columbus_test"\."active_users" AS\n/);
});

test('manual transactions keep changes until commit or rollback', { skip }, async () => {
	await pg().apply(ref('orders'), [{ kind: 'update', key: { id: '1' }, values: { total: '11' } }], 'tx');
	assert.equal(await pg().count(ref('orders'), 'total = 11', 'tx'), 1);
	assert.equal(await pg().count(ref('orders'), 'total = 11'), 0);
	await assert.rejects(pg().apply(ref('orders'), [{ kind: 'delete', key: { id: '999' } }], 'tx'), /matched 0 rows/);
	assert.equal(await pg().count(ref('orders'), 'total = 11', 'tx'), 1);
	await pg().rollback('tx');
	assert.equal(await pg().count(ref('orders'), 'total = 11'), 0);

	await pg().apply(ref('orders'), [{ kind: 'update', key: { id: '1' }, values: { total: '12' } }], 'tx');
	await pg().commit('tx');
	assert.equal(await pg().count(ref('orders'), 'total = 12'), 1);
	await pg().apply(ref('orders'), [{ kind: 'update', key: { id: '1' }, values: { total: '10' } }]);
});

test('preview shows the statements that submit would run', { skip }, async () => {
	assert.match(await pg().preview(ref('orders'), [{ kind: 'delete', key: { id: '1' } }]), /^DELETE FROM .+ WHERE .id. = '1';\n$/);
});

test('execute runs console statements on a pinned connection', { skip }, async () => {
	const [rows] = await pg().execute(`SELECT id, email, active, balance FROM ${schema}.users ORDER BY id LIMIT 2`, 'console');
	assert.ok(rows.kind === 'rows');
	assert.deepEqual(rows.columns.map(c => [c.name, c.type, c.numeric]), [['id', 'integer', true], ['email', 'text', false], ['active', 'boolean', false], ['balance', 'numeric', true]]);
	assert.deepEqual(rows.rows[0], ['1', 'user1@example.com', false, '99.50']);
	assert.equal(rows.truncated, false);

	await pg().execute('CREATE TEMP TABLE scratch (n int)', 'console');
	assert.deepEqual(await pg().execute('INSERT INTO scratch VALUES (1), (2)', 'console'), [{ kind: 'count', command: 'INSERT', affected: 2 }]);
	const results = await pg().execute('SELECT count(*) AS n FROM scratch; SELECT 1 AS one', 'console');
	assert.deepEqual(results.map(r => r.kind === 'rows' ? r.rows : r), [[['2']], [['1']]]);

	await pg().rollback('console');
	await assert.rejects(pg().execute('SELECT * FROM scratch', 'console'), /relation "scratch" does not exist/);
	await pg().rollback('console');
});

test('cancel stops a running console statement and grid load', { skip }, async () => {
	const started = Date.now();
	const running = assert.rejects(pg().execute('SELECT pg_sleep(10)', 'sleepy'), /canceling statement due to user request/);
	await new Promise(resolve => setTimeout(resolve, 300));
	assert.equal(await pg().cancel('sleepy'), true);
	await running;
	assert.deepEqual(await pg().execute('SELECT 1 AS one', 'sleepy'), [{ kind: 'rows', columns: [{ name: 'one', type: 'integer', numeric: true }], rows: [['1']], truncated: false }]);
	await pg().rollback('sleepy');

	const load = assert.rejects(pg().select({ table: ref('users'), where: 'pg_sleep(10) IS NOT NULL', orderBy: '', offset: 0, limit: 1, session: 'grid' }), /canceling statement/);
	await new Promise(resolve => setTimeout(resolve, 300));
	assert.equal(await pg().cancel('grid'), true);
	await load;
	assert.ok(Date.now() - started < 5000);
	assert.equal(await pg().cancel('nothing'), false);
});

test('execute reports where result columns come from, also through the paging wrapper', { skip }, async () => {
	const statement = `SELECT o.id, o.user_id, u.email, 1 AS one FROM ${schema}.orders o JOIN ${schema}.users u ON u.id = o.user_id`;
	for (const sql of [statement, `SELECT * FROM (\n${statement}\n) AS columbus_result LIMIT 2 OFFSET 0`]) {
		const [result] = await pg().execute(sql, 'origins');
		assert.ok(result.kind === 'rows');
		assert.deepEqual(result.columns.map(c => c.origin), [
			{ schema, table: 'orders', column: 'id' },
			{ schema, table: 'orders', column: 'user_id' },
			{ schema, table: 'users', column: 'email' },
			undefined,
		], sql);
	}
	await pg().rollback('origins');
});

test('the worker runs the bundled driver', { skip: skip || (!existsSync(resolve('out/worker.js')) && 'run npm run build first') }, async () => {
	const remote = new RemoteDriver('postgres', resolve('out/worker.js'), async () => join(resolve('out'), 'drivers', 'postgres.js'), async () => config!);
	try {
		assert.match(await remote.version(), /^PostgreSQL /);
		const catalog = await remote.catalog();
		assert.ok(catalog.databases[0].schemas.some(s => s.name === schema));
		const page = await remote.select({ table: ref('orders'), where: '', orderBy: 'id', offset: 0, limit: 2 });
		assert.deepEqual(page.rows, [['1', '1', '10.00'], ['2', '1', '20.00']]);
		await assert.rejects(remote.count(ref('missing'), ''), /does not exist/);
		const running = assert.rejects(remote.execute('SELECT pg_sleep(10)', 'sleepy'), /canceling statement/);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.equal(await remote.cancel('sleepy'), true);
		await running;
	} finally {
		remote.dispose();
	}
});

test('export cursors stream the whole table without offsets', { skip }, async () => {
	const total = await pg().count(ref('users'), 'active');
	const id = await pg().openCursor({ table: ref('users'), where: 'active', orderBy: 'id' });
	const first = await pg().fetchCursor(id, 7);
	assert.deepEqual([first.rows.length, first.done, first.rows.every(row => row[4] === true)], [7, false, true]);
	const rest = await pg().fetchCursor(id, 1000);
	assert.deepEqual([first.rows.length + rest.rows.length, rest.done], [total, true]);
	await pg().closeCursor(id);
	await assert.rejects(pg().fetchCursor(id, 1), /closed/);
	await assert.rejects(pg().openCursor({ table: ref('users'), where: 'nope = 1', orderBy: '' }), /nope/);
});

test('one data source shows several databases', { skip }, async () => {
	const extra = 'columbus_test_extra';
	await run(`DROP DATABASE IF EXISTS ${extra}`);
	await run(`CREATE DATABASE ${extra}`);
	await run('CREATE TABLE items (id integer PRIMARY KEY, title text); INSERT INTO items VALUES (1, \'pen\'), (2, \'ink\');', extra);
	const multi = new PostgresDriver(config!);
	try {
		const single = await multi.catalog();
		assert.deepEqual(single.databases.map(d => d.name), [config!.database]);
		assert.ok(single.available?.includes(extra));
		const both = await multi.catalog([config!.database, extra]);
		assert.deepEqual(both.databases.map(d => d.name), [config!.database, extra]);
		assert.deepEqual(both.databases[1].schemas.find(s => s.name === 'public')?.tables.map(t => t.name), ['items']);
		const items = { database: extra, schema: 'public', table: 'items' };
		assert.deepEqual((await multi.select({ table: items, where: '', orderBy: 'id', offset: 0, limit: 10 })).rows, [['1', 'pen'], ['2', 'ink']]);
		await multi.apply(items, [{ kind: 'update', key: { id: 2 }, values: { title: 'ink pot' } }]);
		assert.equal(await multi.count(items, `title = 'ink pot'`), 1);
		const [inExtra] = await multi.execute('SELECT current_database()', 'console', extra);
		const [inMain] = await multi.execute('SELECT current_database()', 'console');
		assert.deepEqual([inExtra.kind === 'rows' && inExtra.rows[0][0], inMain.kind === 'rows' && inMain.rows[0][0]], [extra, config!.database]);
		assert.match(await multi.ddl(items), /^CREATE TABLE "public"\."items"/);
	} finally {
		multi.dispose();
		await new Promise(resolve => setTimeout(resolve, 200));
		await run(`DROP DATABASE IF EXISTS ${extra} WITH (FORCE)`);
	}
});
