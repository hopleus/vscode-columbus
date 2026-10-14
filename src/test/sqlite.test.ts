import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TableInfo } from '../catalog';
import { formatUrl, parseUrl } from '../drivers/connection';
import type { ConnectionConfig } from '../drivers/connection';
import { RemoteDriver } from '../drivers/remote';
import { SqliteDriver } from '../drivers/sqlite';
import { splitStatements } from '../shared/statements';

const available = (() => {
	try {
		return typeof (createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')).StatementSync.prototype.setReturnArrays === 'function';
	} catch {
		return false;
	}
})();
const skip = available ? false : 'node:sqlite is not available in this Node.js';
const dir = mkdtempSync(join(tmpdir(), 'columbus-sqlite-'));
const file = join(dir, 'shop.db');
const config: ConnectionConfig = { driver: 'sqlite', host: '', port: 0, database: file, user: '', password: '', ssl: 'disable' };
const ref = (table: string) => ({ database: 'shop.db', schema: 'main', table });
const built = resolve('out/drivers/sqlite.js');
const hostModule = existsSync(built) ? built : null;

const SETUP = `
	CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		email TEXT NOT NULL UNIQUE,
		name TEXT,
		balance REAL NOT NULL DEFAULT 0,
		avatar BLOB
	);
	CREATE TABLE orders (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL REFERENCES users,
		total NUMERIC NOT NULL,
		big INTEGER
	);
	CREATE INDEX orders_user_idx ON orders (user_id);
	CREATE TABLE notes (body TEXT, tag TEXT);
	CREATE VIEW rich_users AS SELECT id, email FROM users WHERE balance > 10;
	CREATE TRIGGER orders_touch AFTER INSERT ON orders BEGIN
		UPDATE users SET balance = balance + CASE WHEN NEW.total > 0 THEN NEW.total ELSE 0 END WHERE id = NEW.user_id;
	END;
	INSERT INTO users (email, name, balance, avatar) VALUES ('ann@example.com', 'Ann', 5, X'CAFE'), ('bob@example.com', NULL, 20, NULL);
	INSERT INTO notes VALUES ('first', 'a'), ('second', 'a');
	INSERT INTO orders (user_id, total, big) VALUES (1, 7.5, 9007199254740993);
`;

let driver: SqliteDriver | undefined;

before(() => {
	if (available) {
		const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite');
		const db = new DatabaseSync(file);
		db.exec(SETUP);
		db.close();
		driver = new SqliteDriver(config, hostModule);
	}
});

after(() => {
	driver?.dispose();
	rmSync(dir, { recursive: true, force: true });
});

function lite(): SqliteDriver {
	assert.ok(driver);
	return driver;
}

async function table(name: string): Promise<TableInfo> {
	const found = (await lite().catalog()).databases[0].schemas.find(s => s.name === 'main')?.tables.find(t => t.name === name);
	assert.ok(found, `${name} is in the catalog`);
	return found;
}

test('sqlite URLs carry a file path', () => {
	assert.equal(parseUrl('sqlite', 'sqlite:/var/data/app.db').database, '/var/data/app.db');
	assert.equal(parseUrl('sqlite', 'sqlite:///var/data/app.db').database, '/var/data/app.db');
	assert.equal(parseUrl('sqlite', 'file:///var/My%20Data/app.db').database, '/var/My Data/app.db');
	assert.equal(parseUrl('sqlite', 'sqlite:C:\\data\\app.db').database, 'C:\\data\\app.db');
	assert.throws(() => parseUrl('sqlite', 'sqlite:'), /no file path/);
	assert.equal(formatUrl({ driver: 'sqlite', host: '', port: 0, database: '~/app.db', user: '', ssl: 'disable' }), 'sqlite:~/app.db');
});

test('trigger bodies stay in one statement', () => {
	const parts = splitStatements(SETUP, 'sqlite').map(p => p.text.split(/\s+/).slice(0, 3).join(' '));
	assert.deepEqual(parts, [
		'CREATE TABLE users', 'CREATE TABLE orders', 'CREATE INDEX orders_user_idx', 'CREATE TABLE notes', 'CREATE VIEW rich_users',
		'CREATE TRIGGER orders_touch', 'INSERT INTO users', 'INSERT INTO notes', 'INSERT INTO orders',
	]);
	assert.equal(splitStatements('SELECT [a;b], `c;d` FROM t; SELECT 2', 'sqlite').length, 2);
});

test('version checks that the file is a database', { skip }, async () => {
	assert.match(await lite().version(), /^SQLite 3\.\d+/);
	await assert.rejects(new SqliteDriver({ ...config, database: join(dir, 'missing.db') }, hostModule).version(), /Database file not found/);
	const { writeFileSync } = await import('node:fs');
	writeFileSync(join(dir, 'text.db'), 'not a database at all, just some text that is long enough');
	await assert.rejects(new SqliteDriver({ ...config, database: join(dir, 'text.db') }, hostModule).version(), /not a database/);
});

test('catalog lists tables, views, keys, foreign keys and indexes', { skip }, async () => {
	const catalog = await lite().catalog();
	assert.equal(catalog.schemasOnly, true);
	assert.deepEqual(catalog.databases[0].schemas.map(s => s.name), ['main']);
	assert.deepEqual(catalog.databases[0].schemas[0].tables.map(t => `${t.name}:${t.kind}`), ['notes:table', 'orders:table', 'rich_users:view', 'users:table']);
	const users = await table('users');
	assert.deepEqual(users.columns.map(c => [c.name, c.type, c.nullable, !!c.generated]), [
		['id', 'INTEGER', false, true], ['email', 'TEXT', false, false], ['name', 'TEXT', true, false], ['balance', 'REAL', false, false], ['avatar', 'BLOB', true, false],
	]);
	assert.equal(users.columns[3].default, '0');
	assert.deepEqual(users.keys.map(k => [k.columns, k.primary]), [[['id'], true], [['email'], false]]);
	const orders = await table('orders');
	assert.deepEqual(orders.foreignKeys.map(f => [f.columns, f.refTable, f.refColumns]), [[['user_id'], 'users', ['id']]]);
	assert.deepEqual(orders.indexes.map(i => [i.name, i.columns, i.unique]), [['orders_user_idx', ['user_id'], false]]);
	assert.deepEqual((await table('rich_users')).columns.map(c => c.name), ['id', 'email']);
});

test('select pages, filters and converts values', { skip }, async () => {
	const page = await lite().select({ table: ref('users'), where: '', orderBy: 'id', offset: 0, limit: 1 });
	assert.deepEqual(page, { rows: [[1, 'ann@example.com', 'Ann', 12.5, '\\xcafe']], more: true, total: undefined });
	const filtered = await lite().select({ table: ref('users'), where: 'name IS NULL', orderBy: '', offset: 0, limit: 10 });
	assert.deepEqual(filtered.rows.map(r => r[1]), ['bob@example.com']);
	assert.equal(await lite().count(ref('users'), 'balance > 1'), 2);
	const big = await lite().select({ table: ref('orders'), where: '', orderBy: '', offset: 0, limit: 10 });
	assert.deepEqual(big.rows[0], [1, 1, 7.5, '9007199254740993']);
});

test('changes are saved by key, or by every column without one', { skip }, async () => {
	await lite().apply(ref('users'), [
		{ kind: 'update', key: { id: 2 }, values: { name: 'Bob' } },
		{ kind: 'insert', values: { email: 'cid@example.com', balance: '3' } },
	]);
	assert.deepEqual((await lite().select({ table: ref('users'), where: 'id > 1', orderBy: 'id', offset: 0, limit: 10 })).rows.map(r => r.slice(0, 4)), [
		[2, 'bob@example.com', 'Bob', 20], [3, 'cid@example.com', null, 3],
	]);
	await assert.rejects(lite().apply(ref('notes'), [{ kind: 'update', key: { tag: 'a' }, values: { body: 'x' } }]), /matched 2 rows/);
	await lite().apply(ref('notes'), [{ kind: 'delete', key: { body: 'first', tag: 'a' } }]);
	assert.equal(await lite().count(ref('notes'), ''), 1);
	assert.equal(await lite().preview(ref('users'), [{ kind: 'update', key: { id: 1 }, values: { name: "O'Hara" } }]), `UPDATE "main"."users" SET "name" = 'O''Hara' WHERE "id" = 1;\n`);
});

test('ddl returns the table with its indexes and triggers', { skip }, async () => {
	const ddl = await lite().ddl(ref('orders'));
	assert.match(ddl, /^CREATE TABLE orders \(/);
	assert.match(ddl, /CREATE INDEX orders_user_idx ON orders \(user_id\);/);
	assert.match(ddl, /CREATE TRIGGER orders_touch[\s\S]*END;\n$/);
	assert.match(await lite().ddl(ref('rich_users')), /^CREATE VIEW rich_users AS/);
});

test('execute runs several statements and knows where columns come from', { skip }, async () => {
	const results = await lite().execute(`
		INSERT INTO orders (user_id, total) VALUES (2, 10);
		CREATE TRIGGER noop AFTER DELETE ON notes BEGIN SELECT 1; END;
		SELECT u.name, o.total, count(*) AS n FROM users u JOIN orders o ON o.user_id = u.id GROUP BY o.id ORDER BY o.id;
	`, 'console');
	assert.deepEqual(results.map(r => r.kind === 'count' ? `${r.command}:${r.affected}` : 'rows'), ['INSERT:2', 'CREATE:0', 'rows']);
	const rows = results[2];
	assert.ok(rows.kind === 'rows');
	assert.deepEqual(rows.rows, [['Ann', 7.5, 1], ['Bob', 10, 1]]);
	assert.deepEqual(rows.columns.map(c => [c.name, c.type, c.numeric, c.origin && `${c.origin.schema}.${c.origin.table}.${c.origin.column}`]), [
		['name', 'text', false, 'main.users.name'], ['total', 'numeric', true, 'main.orders.total'], ['n', 'integer', true, undefined],
	]);
	assert.equal((await lite().execute('SELECT balance FROM users WHERE id = 2', 'console'))[0].kind, 'rows');
});

test('console sessions keep transactions until commit or rollback', { skip }, async () => {
	await lite().execute('BEGIN', 'tx');
	await lite().execute(`INSERT INTO notes VALUES ('draft', 'b')`, 'tx');
	assert.equal(await lite().count(ref('notes'), `tag = 'b'`), 0);
	await lite().rollback('tx');
	await lite().execute('BEGIN', 'tx');
	await lite().execute(`INSERT INTO notes VALUES ('kept', 'b')`, 'tx');
	await lite().commit('tx');
	assert.equal(await lite().count(ref('notes'), `tag = 'b'`), 1);
	await lite().commit('tx');
});

test('the worker runs the bundled SQLite driver', { skip: skip || (!existsSync(resolve('out/drivers/sqlite.js')) && 'run npm run build first') }, async () => {
	const remote = new RemoteDriver('sqlite', resolve('out/worker.js'), async () => resolve('out/drivers/sqlite.js'), async () => config);
	try {
		assert.match(await remote.version(), /^SQLite /);
		assert.equal((await remote.catalog()).databases[0].schemas[0].tables.length, 4);
		const endless = remote.execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n', 'worker');
		await new Promise(done => setTimeout(done, 300));
		assert.equal((await remote.catalog()).databases[0].schemas[0].tables.length, 4);
		assert.equal(await remote.cancel('worker'), true);
		await assert.rejects(endless, /^Error: Cancelled/);
		assert.equal((await remote.execute('SELECT count(*) AS users FROM users', 'worker'))[0].kind, 'rows');
	} finally {
		remote.dispose();
	}
});

test('export cursors iterate the table', { skip }, async () => {
	const id = await lite().openCursor({ table: ref('users'), where: '', orderBy: 'id' });
	const first = await lite().fetchCursor(id, 2);
	assert.deepEqual([first.rows.map(r => r[0]), first.done], [[1, 2], false]);
	const rest = await lite().fetchCursor(id, 100);
	assert.equal(rest.done, true);
	await lite().closeCursor(id);
});

test('dropping a key rebuilds the table with its data, indexes and triggers', { skip }, async () => {
	const { sqliteRebuild } = await import('../explorer/scripts');
	const path = join(dir, 'rebuild.db');
	const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite');
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT);
		CREATE TABLE pets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			owner_id INTEGER CONSTRAINT pet_owner REFERENCES owners (id) ON DELETE CASCADE,
			tag TEXT,
			kind TEXT,
			label TEXT GENERATED ALWAYS AS (kind || ':' || tag),
			CONSTRAINT pets_tag_kind UNIQUE (tag, kind)
		);
		CREATE TABLE visits (pet INTEGER, day TEXT, PRIMARY KEY (pet, day)) WITHOUT ROWID;
		CREATE INDEX pets_kind ON pets (kind);
		CREATE VIEW pet_labels AS SELECT label FROM pets;
		CREATE TRIGGER owners_gone AFTER DELETE ON owners BEGIN DELETE FROM pets WHERE owner_id = OLD.id; END;
		CREATE TRIGGER pets_upper AFTER INSERT ON pets BEGIN UPDATE pets SET kind = upper(NEW.kind) WHERE id = NEW.id; END;
		INSERT INTO owners VALUES (1, 'Ann');
		INSERT INTO pets (owner_id, tag, kind) VALUES (1, 'a1', 'cat'), (1, 'a2', 'dog');
	`);
	db.close();
	const local = new SqliteDriver({ ...config, database: path }, hostModule);
	const pets = { database: 'rebuild.db', schema: 'main', table: 'pets' };
	try {
		const script = sqliteRebuild(await local.ddl(pets), pets, { kind: 'foreignKey', columns: ['owner_id'] });
		assert.match(script, /^PRAGMA foreign_keys = OFF;\nPRAGMA legacy_alter_table = ON;\nBEGIN;\nCREATE TABLE "main"\."columbus_rebuild_pets"/);
		assert.doesNotMatch(script, /REFERENCES/);
		await local.execute(script, 'tree');
		const table = async (name: string) => (await local.catalog()).databases[0].schemas[0].tables.find(t => t.name === name)!;
		const rebuilt = await table('pets');
		assert.deepEqual(rebuilt.foreignKeys, []);
		assert.deepEqual(rebuilt.keys.map(k => k.columns), [['id'], ['tag', 'kind']]);
		assert.deepEqual(rebuilt.indexes.map(i => i.name).filter(n => !n.startsWith('sqlite_')), ['pets_kind']);
		assert.equal(rebuilt.triggers?.[0].name, 'pets_upper');
		assert.deepEqual((await local.execute('SELECT label FROM pet_labels ORDER BY label', 'check'))[0], { kind: 'rows', columns: [{ name: 'label', type: 'text', numeric: false, origin: { schema: 'main', table: 'pets', column: 'label' } }], rows: [['CAT:a1'], ['DOG:a2']], truncated: false });
		assert.deepEqual((await local.select({ table: pets, where: '', orderBy: 'id', offset: 0, limit: 10 })).rows, [[1, 1, 'a1', 'CAT', 'CAT:a1'], [2, 1, 'a2', 'DOG', 'DOG:a2']]);

		await local.execute(sqliteRebuild(await local.ddl(pets), pets, { kind: 'key', columns: ['tag', 'kind'] }), 'tree');
		assert.deepEqual((await table('pets')).keys.map(k => k.columns), [['id']]);
		const visits = { ...pets, table: 'visits' };
		await local.execute(sqliteRebuild(await local.ddl(visits), visits, { kind: 'primaryKey', columns: ['pet', 'day'] }), 'tree');
		assert.deepEqual((await table('visits')).keys, []);
		assert.throws(() => sqliteRebuild('CREATE TABLE t (a INTEGER)', { ...pets, table: 't' }, { kind: 'key', columns: ['a'] }), /Could not find/);
	} finally {
		local.dispose();
	}
});

test('a running statement is cancelled without touching other sessions', { skip: skip || (!hostModule && 'run npm run build first') }, async () => {
	const path = join(dir, 'cancel.db');
	const setup = new (createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(path);
	setup.exec('CREATE TABLE marks (id INTEGER PRIMARY KEY)');
	setup.close();
	const sessions = new SqliteDriver({ ...config, database: path }, hostModule);
	try {
		assert.equal(await sessions.cancel('idle'), false);
		await sessions.execute('BEGIN; INSERT INTO marks VALUES (1)', 'keep');
		const started = Date.now();
		const endless = sessions.execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n', 'busy');
		await new Promise(done => setTimeout(done, 300));
		assert.ok((await sessions.catalog()).databases.length > 0);
		assert.equal(await sessions.cancel('busy'), true);
		await assert.rejects(endless, { message: 'Cancelled' });
		assert.ok(Date.now() - started < 5000);
		const pending = sessions.execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n', 'keep');
		await new Promise(done => setTimeout(done, 200));
		assert.equal(await sessions.cancel('keep'), true);
		await assert.rejects(pending, { message: 'Cancelled; the open transaction of this session was rolled back' });
		assert.equal(await sessions.count({ database: 'cancel.db', schema: 'main', table: 'marks' }, ''), 0);
		await sessions.execute('BEGIN; INSERT INTO marks VALUES (1)', 'keep');
		await sessions.commit('keep');
		assert.equal(await sessions.count({ database: 'cancel.db', schema: 'main', table: 'marks' }, ''), 1);
		assert.deepEqual((await sessions.execute('SELECT 2 AS two', 'busy'))[0], { kind: 'rows', columns: [{ name: 'two', type: 'integer', numeric: true }], rows: [[2]], truncated: false });
	} finally {
		sessions.dispose();
	}
});
