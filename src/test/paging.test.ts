import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { countSql, pageSql, pageable, selectItems } from '../console/paging';

test('pageable accepts single reading statements only', () => {
	assert.equal(pageable('SELECT * FROM users', 'postgres'), true);
	assert.equal(pageable('-- latest\nWITH x AS (SELECT 1) SELECT * FROM x', 'postgres'), true);
	assert.equal(pageable("SELECT 'insert into' AS text", 'mysql'), true);
	assert.equal(pageable('SELECT * INTO copy FROM users', 'postgres'), false);
	assert.equal(pageable('WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone', 'postgres'), false);
	assert.equal(pageable('UPDATE users SET a = 1', 'postgres'), false);
	assert.equal(pageable('SELECT 1; SELECT 2', 'postgres'), false);
	assert.equal(pageable('SHOW TABLES', 'mysql'), false);
});

test('pageSql wraps the statement with filters and a page window', () => {
	assert.equal(
		pageSql('SELECT * FROM users -- all', 'id > 1', 'email DESC', 501, 500),
		'SELECT * FROM (\nSELECT * FROM users -- all\n) AS columbus_result WHERE id > 1 ORDER BY email DESC LIMIT 501 OFFSET 500'
	);
	assert.equal(pageSql('SELECT 1', ' ', '', 10.7, -3), 'SELECT * FROM (\nSELECT 1\n) AS columbus_result LIMIT 10 OFFSET 0');
	assert.equal(countSql('SELECT 1', ''), 'SELECT count(*) AS count FROM (SELECT * FROM (\nSELECT 1\n) AS columbus_result) AS columbus_result_count');
});

test('selectItems maps result positions to the columns of the select list', () => {
	assert.deepEqual(selectItems('SELECT o.id, o.user_id AS uid, u.email mail, 1 AS one, count(*) FROM shop.orders o JOIN users u ON u.id = o.user_id', 'mysql'), [
		{ qualifier: 'o', column: 'id', star: false },
		{ qualifier: 'o', column: 'user_id', alias: 'uid', star: false },
		{ qualifier: 'u', column: 'email', alias: 'mail', star: false },
		{ alias: 'one', star: false },
		{ star: false },
	]);
	assert.deepEqual(selectItems('SELECT DISTINCT `name`, shop.users.email FROM shop.users', 'mysql'), [
		{ qualifier: undefined, column: 'name', star: false },
		{ qualifier: 'users', column: 'email', star: false },
	]);
	assert.ok(selectItems('SELECT u.*, o.id FROM users u, orders o', 'mysql')?.[0].star);
	assert.equal(selectItems('SHOW TABLES', 'mysql'), undefined);
});
