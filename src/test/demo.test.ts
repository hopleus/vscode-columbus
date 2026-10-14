import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DemoDriver } from '../drivers/demo';

const users = { database: 'demo', schema: 'public', table: 'users' };

test('select pages and counts rows', async () => {
	const driver = new DemoDriver();
	const { rows, total } = await driver.select({ table: users, where: '', orderBy: '', offset: 10, limit: 5 });
	assert.equal(total, 1200);
	assert.deepEqual(rows.map(r => r[0]), [11, 12, 13, 14, 15]);
});

test('select sorts by ORDER BY', async () => {
	const driver = new DemoDriver();
	const { rows } = await driver.select({ table: users, where: '', orderBy: 'id DESC', offset: 0, limit: 2 });
	assert.deepEqual(rows.map(r => r[0]), [1200, 1199]);
	await assert.rejects(driver.select({ table: users, where: '', orderBy: 'missing', offset: 0, limit: 1 }), /Unknown column/);
});

test('apply updates, deletes and inserts atomically', async () => {
	const driver = new DemoDriver();
	await driver.apply(users, [
		{ kind: 'update', key: { id: 1 }, values: { name: 'Changed', balance: '12.5' } },
		{ kind: 'delete', key: { id: 2 } },
		{ kind: 'insert', values: { email: 'new@example.com' } },
	]);
	const { rows, total } = await driver.select({ table: users, where: '', orderBy: 'id', offset: 0, limit: 2000 });
	assert.equal(total, 1200);
	assert.equal(rows[0][2], 'Changed');
	assert.equal(rows[0][3], '12.50');
	assert.equal(rows[1][0], 3);
	assert.deepEqual(rows.at(-1)?.slice(0, 5), [1201, 'new@example.com', null, '0.00', 1]);

	await assert.rejects(driver.apply(users, [
		{ kind: 'delete', key: { id: 3 } },
		{ kind: 'insert', values: { name: 'No email' } },
	]), /doesn't have a default value/);
	const after = await driver.select({ table: users, where: '', orderBy: 'id', offset: 1, limit: 1 });
	assert.equal(after.rows[0][0], 3);
});

test('manual transactions are isolated until commit', async () => {
	const driver = new DemoDriver();
	await driver.apply(users, [{ kind: 'delete', key: { id: 1 } }], 'tx');
	assert.equal(await driver.count(users, '', 'tx'), 1199);
	assert.equal(await driver.count(users, ''), 1200);
	await driver.rollback('tx');
	assert.equal(await driver.count(users, '', 'tx'), 1200);
	await driver.apply(users, [{ kind: 'delete', key: { id: 1 } }], 'tx');
	await driver.commit('tx');
	assert.equal(await driver.count(users, ''), 1199);
});

test('ddl and preview describe the demo tables', async () => {
	const driver = new DemoDriver();
	assert.match(await driver.ddl(users), /^CREATE TABLE "public"\."users"\n\(\n {4}"id" int unsigned NOT NULL,/);
	assert.equal(await driver.preview(users, [{ kind: 'delete', key: { id: 3 } }]), 'DELETE FROM "public"."users" WHERE "id" = 3;\n');
});
