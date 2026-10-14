import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import type { TableInfo } from '../catalog';
import { parseUrl } from '../drivers/connection';
import { MysqlDriver } from '../drivers/mysql';
import { RemoteDriver } from '../drivers/remote';

const url = process.env.COLUMBUS_MYSQL_URL;
const skip = url ? false : 'COLUMBUS_MYSQL_URL is not set';
const config = url ? { ...parseUrl('mysql', url), database: '' } : undefined;
const schema = 'columbus_test';
const ref = (table: string) => ({ database: '', schema, table });

const SETUP = `
	DROP DATABASE IF EXISTS ${schema};
	CREATE DATABASE ${schema};
	CREATE TABLE ${schema}.users (
		id int unsigned AUTO_INCREMENT PRIMARY KEY,
		email varchar(255) NOT NULL UNIQUE,
		name varchar(100) NULL,
		balance decimal(10,2) NOT NULL DEFAULT 0,
		active tinyint(1) NOT NULL DEFAULT 1,
		meta json NULL,
		avatar varbinary(4) NULL,
		big bigint NULL,
		created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE ${schema}.orders (
		id bigint AUTO_INCREMENT PRIMARY KEY,
		user_id int unsigned NOT NULL,
		total decimal(10,2) NOT NULL,
		KEY orders_user_idx (user_id),
		CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES ${schema}.users (id)
	);
	CREATE TABLE ${schema}.notes (body text, meta json);
	CREATE VIEW ${schema}.active_users AS SELECT id, email FROM ${schema}.users WHERE active = 1;
	INSERT INTO ${schema}.users (email, name, balance, active, meta)
		WITH RECURSIVE seq (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 30)
		SELECT CONCAT('user', i, '@example.com'), IF(i % 5 = 0, NULL, CONCAT('User ', i)), i * 1.5, i % 3 <> 0, IF(i % 2 = 0, '{"n": 1}', NULL) FROM seq;
	UPDATE ${schema}.users SET avatar = 0xDEADBEEF, big = 9007199254740993 WHERE id = 1;
	INSERT INTO ${schema}.orders (user_id, total) VALUES (1, 10), (1, 20), (2, 30);
	INSERT INTO ${schema}.notes VALUES ('first', '{"a": 1}'), ('second', NULL);
	CREATE FUNCTION ${schema}.total_of(uid INT) RETURNS DECIMAL(10,2) DETERMINISTIC READS SQL DATA RETURN (SELECT SUM(total) FROM ${schema}.orders WHERE user_id = uid);
	CREATE PROCEDURE ${schema}.touch(IN n INT) SELECT n;
	ALTER TABLE ${schema}.orders ADD CONSTRAINT orders_total_check CHECK (total >= 0);
	CREATE TRIGGER ${schema}.orders_abs BEFORE INSERT ON ${schema}.orders FOR EACH ROW SET NEW.total = ABS(NEW.total);
`;

let driver: MysqlDriver | undefined;

async function run(sql: string): Promise<void> {
	if (!config) {
		return;
	}
	const connection = await createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, multipleStatements: true });
	try {
		await connection.query(sql);
	} finally {
		await connection.end();
	}
}

before(async () => {
	await run(SETUP);
	driver = config && new MysqlDriver(config);
});

after(async () => {
	driver?.dispose();
	await run(`DROP DATABASE IF EXISTS ${schema}`);
});

function my(): MysqlDriver {
	assert.ok(driver);
	return driver;
}

async function table(name: string): Promise<TableInfo> {
	const catalog = await my().catalog();
	assert.equal(catalog.schemasOnly, true);
	const found = catalog.databases[0].schemas.find(s => s.name === schema)?.tables.find(t => t.name === name);
	assert.ok(found, `${name} is in the catalog`);
	return found;
}

test('version names the server', { skip }, async () => {
	assert.match(await my().version(), /^(MySQL|MariaDB) \d+\.\d+\.\d+/);
});

test('catalog lists every user schema with columns, keys and indexes', { skip }, async () => {
	const catalog = await my().catalog();
	const names = catalog.databases[0].schemas.map(s => s.name);
	assert.ok(names.includes(schema));
	assert.ok(!names.includes('mysql') && !names.includes('information_schema'));

	const users = await table('users');
	assert.equal(users.kind, 'table');
	assert.deepEqual(users.columns.map(c => c.name), ['id', 'email', 'name', 'balance', 'active', 'meta', 'avatar', 'big', 'created_at']);
	assert.match(users.columns[0].type, /^int(\(10\))? unsigned$/);
	assert.equal(users.columns[0].generated, true);
	assert.equal(users.columns[2].nullable, true);
	assert.equal(users.columns[2].default, undefined);
	assert.match(users.columns[3].default ?? '', /^'?0(\.00)?'?$/);
	assert.match(users.columns[8].default ?? '', /current_timestamp/i);
	assert.deepEqual(users.keys.map(k => [k.columns, k.primary]), [[['email'], false], [['id'], true]]);

	const orders = await table('orders');
	assert.deepEqual(orders.foreignKeys.map(f => [f.name, f.columns, f.refTable, f.refColumns]), [['fk_orders_user', ['user_id'], 'users', ['id']]]);
	assert.deepEqual(orders.indexes.map(i => [i.name, i.columns, i.unique]), [['orders_user_idx', ['user_id'], false], ['PRIMARY', ['id'], true]]);

	assert.equal((await table('active_users')).kind, 'view');
});

test('catalog lists routines, checks and triggers', { skip }, async () => {
	const objects = (await my().catalog()).databases[0].schemas.find(s => s.name === schema)?.objects ?? [];
	assert.deepEqual(objects.map(o => `${o.type}:${o.name}`), ['function:total_of', 'procedure:touch']);
	assert.match(objects[0].detail ?? '', /^\(uid int(\(11\))?\) → decimal\(10,2\)$/);
	assert.match(objects[1].detail ?? '', /^\(IN n int(\(11\))?\)$/);
	const orders = await table('orders');
	assert.deepEqual(orders.checks?.map(c => [c.name, c.detail]), [['orders_total_check', '(`total` >= 0)']]);
	assert.deepEqual(orders.triggers?.map(t => [t.name, t.detail]), [['orders_abs', 'BEFORE INSERT']]);
	assert.match(await my().definition(objects[0]), /^CREATE DEFINER=\S+ FUNCTION `total_of`/);
	assert.match(await my().definition(orders.triggers![0]), /^CREATE DEFINER=\S+ TRIGGER (`?columbus_test`?\.)?`?orders_abs`? BEFORE INSERT ON /);
	assert.equal(await my().definition(orders.checks![0]), 'ALTER TABLE `columbus_test`.`orders`\n    ADD CONSTRAINT `orders_total_check` CHECK (`total` >= 0);\n');
});

test('select pages, filters, sorts and keeps exact values', { skip }, async () => {
	const page = await my().select({ table: ref('users'), where: '', orderBy: 'id', offset: 0, limit: 10 });
	assert.equal(page.rows.length, 10);
	assert.equal(page.more, true);
	assert.equal(page.total, undefined);
	assert.deepEqual(page.rows[0].slice(0, 8), [1, 'user1@example.com', 'User 1', '1.50', 1, null, '0xDEADBEEF', '9007199254740993']);
	assert.equal(page.rows[1][5], '{"n": 1}');
	assert.match(String(page.rows[0][8]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

	const filtered = await my().select({ table: ref('users'), where: 'name IS NULL', orderBy: '`id` DESC', offset: 0, limit: 10 });
	assert.deepEqual(filtered.rows.map(r => r[0]), [30, 25, 20, 15, 10, 5]);
	assert.equal(filtered.total, 6);

	assert.equal(await my().count(ref('users'), 'active = 1'), 20);
	await assert.rejects(my().select({ table: ref('users'), where: 'missing = 1', orderBy: '', offset: 0, limit: 1 }), /Unknown column 'missing'/);
	await assert.rejects(my().select({ table: ref('users'), where: '1 = 1; DROP TABLE users', orderBy: '', offset: 0, limit: 1 }), /SQL syntax/);
});

test('apply runs changes in one transaction', { skip }, async () => {
	await my().apply(ref('users'), [
		{ kind: 'update', key: { id: 1 }, values: { name: 'Changed', active: '0', balance: '99.5' } },
		{ kind: 'update', key: { id: 3 }, values: { name: 'User 3' } },
		{ kind: 'insert', values: { email: 'new@example.com' } },
		{ kind: 'delete', key: { id: 30 } },
	]);
	const rows = (await my().select({ table: ref('users'), where: `id = 1 OR email = 'new@example.com'`, orderBy: 'id', offset: 0, limit: 10 })).rows;
	assert.deepEqual(rows.map(r => r.slice(1, 5)), [['user1@example.com', 'Changed', '99.50', 0], ['new@example.com', null, '0.00', 1]]);
	assert.equal(await my().count(ref('users'), 'id = 30'), 0);

	await assert.rejects(my().apply(ref('users'), [
		{ kind: 'update', key: { id: 2 }, values: { name: 'Lost' } },
		{ kind: 'insert', values: { name: 'No email' } },
	]), /Field 'email' doesn't have a default value/);
	assert.equal((await my().select({ table: ref('users'), where: 'id = 2', orderBy: '', offset: 0, limit: 1 })).rows[0][2], 'User 2');

	await assert.rejects(my().apply(ref('users'), [{ kind: 'delete', key: { id: 999 } }]), /matched 0 rows/);
});

test('apply finds rows of tables without a primary key by every column', { skip }, async () => {
	await my().apply(ref('notes'), [
		{ kind: 'update', key: { body: 'first', meta: '{"a": 1}' }, values: { body: 'updated' } },
		{ kind: 'delete', key: { body: 'second', meta: null } },
	]);
	const rows = (await my().select({ table: ref('notes'), where: '', orderBy: '', offset: 0, limit: 10 })).rows;
	assert.deepEqual(rows, [['updated', '{"a": 1}']]);
});

test('ddl shows tables and views', { skip }, async () => {
	const ddl = await my().ddl(ref('orders'));
	assert.match(ddl, /^CREATE TABLE `orders` \(/);
	assert.match(ddl, /CONSTRAINT `fk_orders_user` FOREIGN KEY \(`user_id`\) REFERENCES `users` \(`id`\)/);
	assert.match(await my().ddl(ref('active_users')), /VIEW (`columbus_test`\.)?`active_users` AS/);
});

test('manual transactions keep changes until commit or rollback', { skip }, async () => {
	await my().apply(ref('orders'), [{ kind: 'update', key: { id: '1' }, values: { total: '11' } }], 'tx');
	assert.equal(await my().count(ref('orders'), 'total = 11', 'tx'), 1);
	assert.equal(await my().count(ref('orders'), 'total = 11'), 0);
	await assert.rejects(my().apply(ref('orders'), [{ kind: 'delete', key: { id: '999' } }], 'tx'), /matched 0 rows/);
	assert.equal(await my().count(ref('orders'), 'total = 11', 'tx'), 1);
	await my().rollback('tx');
	assert.equal(await my().count(ref('orders'), 'total = 11'), 0);

	await my().apply(ref('orders'), [{ kind: 'update', key: { id: '1' }, values: { total: '12' } }], 'tx');
	await my().commit('tx');
	assert.equal(await my().count(ref('orders'), 'total = 12'), 1);
	await my().apply(ref('orders'), [{ kind: 'update', key: { id: '1' }, values: { total: '10' } }]);
});

test('preview shows the statements that submit would run', { skip }, async () => {
	assert.match(await my().preview(ref('orders'), [{ kind: 'delete', key: { id: '1' } }]), /^DELETE FROM .+ WHERE .id. = '1';\n$/);
});

test('execute runs console statements on a pinned connection', { skip }, async () => {
	const [rows] = await my().execute(`SELECT id, email, balance FROM ${schema}.users ORDER BY id LIMIT 2`, 'console');
	assert.ok(rows.kind === 'rows');
	assert.deepEqual(rows.columns.map(c => [c.name, c.type, c.numeric]), [['id', 'int', true], ['email', 'varchar', false], ['balance', 'decimal', true]]);
	assert.deepEqual(rows.rows[0], [1, 'user1@example.com', '99.50']);

	await my().execute(`USE ${schema}`, 'console');
	await my().execute('CREATE TEMPORARY TABLE scratch (n int)', 'console');
	assert.deepEqual(await my().execute('INSERT INTO scratch VALUES (1), (2)', 'console'), [{ kind: 'count', command: 'INSERT', affected: 2 }]);
	const [count] = await my().execute('SELECT COUNT(*) AS n FROM scratch', 'console');
	assert.deepEqual(count.kind === 'rows' && count.rows, [['2']]);

	await my().rollback('console');
	await assert.rejects(my().execute(`SELECT * FROM ${schema}.scratch`, 'console'), /doesn't exist/);
	await my().rollback('console');
});

test('cancel stops a running console statement and grid load', { skip }, async () => {
	const started = Date.now();
	const running = assert.rejects(my().execute(`SELECT COUNT(*) FROM ${schema}.users WHERE SLEEP(10) = 0`, 'sleepy'), /interrupted/);
	await new Promise(resolve => setTimeout(resolve, 300));
	assert.equal(await my().cancel('sleepy'), true);
	await running;
	const [after] = await my().execute('SELECT 1 AS one', 'sleepy');
	assert.ok(after.kind === 'rows');
	assert.deepEqual([after.columns[0].name, after.columns[0].numeric, String(after.rows[0][0])], ['one', true, '1']);
	await my().rollback('sleepy');

	const load = assert.rejects(my().select({ table: ref('users'), where: 'SLEEP(10) = 0', orderBy: '', offset: 0, limit: 1, session: 'grid' }), /interrupted/);
	await new Promise(resolve => setTimeout(resolve, 300));
	assert.equal(await my().cancel('grid'), true);
	await load;
	assert.ok(Date.now() - started < 5000);
	assert.equal(await my().cancel('nothing'), false);
});

test('execute reports where result columns come from, also through the paging wrapper', { skip }, async () => {
	const statement = `SELECT o.id, o.user_id, u.email, 1 AS one FROM ${schema}.orders o JOIN ${schema}.users u ON u.id = o.user_id`;
	const [direct] = await my().execute(statement, 'origins');
	assert.ok(direct.kind === 'rows');
	assert.deepEqual(direct.columns.map(c => c.origin), [
		{ schema, table: 'orders', column: 'id' },
		{ schema, table: 'orders', column: 'user_id' },
		{ schema, table: 'users', column: 'email' },
		undefined,
	]);
	const [wrapped] = await my().execute(`SELECT * FROM (\n${statement}\n) AS columbus_result LIMIT 2 OFFSET 0`, 'origins');
	assert.ok(wrapped.kind === 'rows');
	const mariadb = /^MariaDB/.test(await my().version());
	assert.deepEqual(wrapped.columns.map(c => c.origin?.table), mariadb ? ['columbus_result', 'columbus_result', 'columbus_result', undefined] : ['o', 'o', 'u', undefined]);
	await my().rollback('origins');
});

test('the worker runs the bundled driver', { skip: skip || (!existsSync(resolve('out/drivers/mysql.js')) && 'run npm run build first') }, async () => {
	const remote = new RemoteDriver('mysql', resolve('out/worker.js'), async () => join(resolve('out'), 'drivers', 'mysql.js'), async () => config!);
	try {
		const page = await remote.select({ table: ref('orders'), where: '', orderBy: 'id', offset: 0, limit: 2 });
		assert.deepEqual(page.rows, [['1', 1, '10.00'], ['2', 1, '20.00']]);
		await assert.rejects(remote.count(ref('missing'), ''), /doesn't exist/);
	} finally {
		remote.dispose();
	}
});

test('export cursors stream the whole table without offsets', { skip }, async () => {
	const total = await my().count(ref('users'), 'active = 1');
	const id = await my().openCursor({ table: ref('users'), where: 'active = 1', orderBy: 'id' });
	const first = await my().fetchCursor(id, 7);
	assert.deepEqual([first.rows.length, first.done, first.rows.every(row => row[4] === 1)], [7, false, true]);
	const rest = await my().fetchCursor(id, 1000);
	assert.deepEqual([first.rows.length + rest.rows.length, rest.done], [total, true]);
	await my().closeCursor(id);
	const early = await my().openCursor({ table: ref('users'), where: '', orderBy: '' });
	assert.equal((await my().fetchCursor(early, 2)).rows.length, 2);
	await my().closeCursor(early);
	await assert.rejects(my().openCursor({ table: ref('users'), where: 'nope = 1', orderBy: '' }), /nope/);
	assert.ok(await my().count(ref('users'), '') > 0);
});

test('MariaDB sequences are listed apart from tables', { skip }, async t => {
	if (!/^MariaDB/.test(await my().version())) {
		t.skip('MySQL has no sequences');
		return;
	}
	await run(`CREATE SEQUENCE ${schema}.invoice_seq START WITH 100`);
	const found = (await my().catalog()).databases[0].schemas.find(s => s.name === schema)!;
	assert.equal(found.tables.some(t => t.name === 'invoice_seq'), false);
	const sequence = found.objects?.find(o => o.name === 'invoice_seq');
	assert.equal(sequence?.type, 'sequence');
	assert.match(await my().definition(sequence!), /^CREATE SEQUENCE `invoice_seq` start with 100/i);
});
