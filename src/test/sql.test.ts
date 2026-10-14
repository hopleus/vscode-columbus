import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mysql, postgres, preview, selectClauses, statement, tableName } from '../drivers/sql';

const table = tableName(postgres, { database: 'db', schema: 'public', table: 'my "users"' });

test('tableName quotes schema and table', () => {
	assert.equal(table, '"public"."my ""users"""');
});

test('update binds values before the key', () => {
	assert.deepEqual(statement(postgres, table, { kind: 'update', key: { id: 7 }, values: { name: 'Bob', email: null } }, true), {
		sql: `UPDATE ${table} SET "name" = $1, "email" = $2 WHERE "id" = $3`,
		params: ['Bob', null, 7],
		single: true,
	});
});

test('keys without a primary key compare as text and match nulls', () => {
	assert.deepEqual(statement(postgres, table, { kind: 'delete', key: { id: 7, meta: '{"a":1}', note: null } }, false), {
		sql: `DELETE FROM ${table} WHERE "id"::text = $1 AND "meta"::text = $2 AND "note" IS NULL`,
		params: [7, '{"a":1}'],
		single: true,
	});
});

test('insert lists only the given columns or uses defaults', () => {
	assert.deepEqual(statement(postgres, table, { kind: 'insert', values: { name: 'Eve', active: true } }, true), {
		sql: `INSERT INTO ${table} ("name", "active") VALUES ($1, $2)`,
		params: ['Eve', true],
		single: false,
	});
	assert.equal(statement(postgres, table, { kind: 'insert', values: {} }, true).sql, `INSERT INTO ${table} DEFAULT VALUES`);
});

test('selectClauses skips empty parts', () => {
	assert.equal(selectClauses('  ', ''), '');
	assert.equal(selectClauses('id > 1', 'name DESC'), 'WHERE id > 1 ORDER BY name DESC');
});

test('mysql quotes with backticks and binds with question marks', () => {
	const users = tableName(mysql, { database: '', schema: 'shop', table: 'my`users' });
	assert.equal(users, '`shop`.`my``users`');
	assert.deepEqual(statement(mysql, users, { kind: 'update', key: { id: 7 }, values: { name: 'Bob' } }, true), {
		sql: 'UPDATE `shop`.`my``users` SET `name` = ? WHERE `id` = ?',
		params: ['Bob', 7],
		single: true,
	});
	assert.equal(
		statement(mysql, users, { kind: 'delete', key: { body: 'x', meta: null } }, false).sql,
		'DELETE FROM `shop`.`my``users` WHERE CAST(`body` AS CHAR) COLLATE utf8mb4_bin = ? AND `meta` IS NULL'
	);
	assert.equal(statement(mysql, users, { kind: 'insert', values: {} }, true).sql, 'INSERT INTO `shop`.`my``users` () VALUES ()');
});

test('preview inlines literals into the statements', () => {
	const users = tableName(postgres, { database: 'db', schema: 'public', table: 'users' });
	assert.equal(
		preview(postgres, users, [
			{ kind: 'update', key: { id: 1 }, values: { name: "O'Neil" } },
			{ kind: 'delete', key: { id: 2 } },
		], true),
		`UPDATE "public"."users" SET "name" = 'O''Neil' WHERE "id" = 1;\nDELETE FROM "public"."users" WHERE "id" = 2;\n`
	);
});

test('SQL expressions are written into statements as they are', () => {
	assert.deepEqual(statement(postgres, table, { kind: 'update', key: { id: 7 }, values: { name: 'Bob' }, expressions: { updated_at: 'now()' } }, true), {
		sql: 'UPDATE "public"."my ""users""" SET "name" = $1, "updated_at" = now() WHERE "id" = $2', params: ['Bob', 7], single: true,
	});
	assert.deepEqual(statement(mysql, '`users`', { kind: 'insert', values: { name: 'Eve' }, expressions: { id: 'DEFAULT' } }, true), {
		sql: 'INSERT INTO `users` (`name`, `id`) VALUES (?, DEFAULT)', params: ['Eve'], single: false,
	});
});
