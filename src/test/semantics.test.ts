import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Catalog, TableInfo } from '../catalog';
import { analyzeDocument, expandStar } from '../console/semantics';

const table = (name: string, columns: string[], kind: 'table' | 'view' = 'table'): TableInfo => ({
	name, kind, keys: [], foreignKeys: [], indexes: [],
	columns: columns.map(column => ({ name: column, type: 'text', nullable: true })),
});

const catalog: Catalog = {
	databases: [{
		name: 'shop',
		schemas: [
			{ name: 'public', tables: [table('users', ['id', 'email', 'name']), table('orders', ['id', 'user_id', 'total', 'status']), table('active_users', ['id', 'email'], 'view')] },
			{ name: 'audit', tables: [table('log', ['id', 'message'])] },
		],
	}],
};

function symbols(sql: string, flavor: 'postgres' | 'mysql' = 'postgres'): string[] {
	return analyzeDocument(catalog, sql, flavor).symbols.map(s => `${sql.slice(s.start, s.start + s.length)}:${s.kind}${s.declaration ? '+' : ''}`);
}

function problems(sql: string, flavor: 'postgres' | 'mysql' = 'postgres'): string[] {
	return analyzeDocument(catalog, sql, flavor).problems.map(p => `${sql.slice(p.start, p.start + p.length)}: ${p.message}${p.suggestions.length ? ` (${p.suggestions.join(', ')})` : ''}`);
}

test('names resolve to schemas, tables, views, columns and aliases', () => {
	assert.deepEqual(symbols('SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE name = 1'), [
		'u:alias', 'email:column', 'o:alias', 'total:column', 'users:table', 'u:alias+', 'orders:table', 'o:alias+',
		'o:alias', 'user_id:column', 'u:alias', 'id:column', 'name:column',
	]);
	assert.deepEqual(symbols('SELECT l.message FROM audit.log AS l, active_users'), ['l:alias', 'message:column', 'audit:schema', 'log:table', 'l:alias+', 'active_users:view']);
	assert.deepEqual(symbols('SELECT `u`.`email` FROM `users` u', 'mysql'), ['`u`:alias', '`email`:column', '`users`:table', 'u:alias+']);
});

test('unknown tables and columns are reported with similar names', () => {
	assert.deepEqual(problems('SELECT * FROM userz'), [`userz: Unable to resolve table 'userz' (users)`]);
	assert.deepEqual(problems('SELECT u.emial FROM users u'), [`emial: Unable to resolve column 'emial' (email)`]);
	assert.deepEqual(problems('SELECT emial FROM users WHERE id = 1'), [`emial: Unable to resolve column 'emial' (email)`]);
	assert.deepEqual(problems('INSERT INTO users (email, nmae) VALUES (1, 2)'), [`nmae: Unable to resolve column 'nmae' (name)`]);
	assert.deepEqual(problems('UPDATE users SET emial = 1 WHERE id = 1'), [`emial: Unable to resolve column 'emial' (email)`]);
	assert.deepEqual(problems('SELECT a.id FROM users u'), [`a: Unable to resolve table or alias 'a'`]);
	assert.deepEqual(problems('SELECT * FROM audit.logs'), [`logs: Unable to resolve table 'logs' (log)`]);
});

test('valid SQL is not reported', () => {
	const valid = [
		'SELECT extract(year FROM u.id) AS y FROM users u',
		'SELECT CAST(id AS bigint), id::text, count(*) AS total FROM users ORDER BY total',
		'SELECT count(*) total, status FROM orders GROUP BY status HAVING count(*) > 1',
		'WITH recent AS (SELECT id, total FROM orders) SELECT r.id, r.total FROM recent r',
		'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n',
		'SELECT * FROM (SELECT id, email AS mail FROM users) x WHERE x.mail IS NOT NULL',
		'SELECT * FROM generate_series(1, 3) AS g(n) WHERE g.n > 1',
		'SELECT * FROM pg_stat_activity',
		'SELECT table_name FROM information_schema.tables',
		'SELECT * FROM users WHERE id = :id AND name = ? AND email IS DISTINCT FROM name',
		'SELECT * FROM users WHERE id > 0 AND email = date \'2024-01-01\' AND current_date > now()',
		'INSERT INTO orders (user_id) SELECT id FROM users ON CONFLICT (id) DO UPDATE SET total = excluded.total',
		'CREATE TEMP TABLE scratch (id int); SELECT id FROM scratch',
		'CREATE TABLE fresh (x int)',
		'DROP TABLE IF EXISTS gone',
		'SELECT id, row_number() OVER (PARTITION BY status ORDER BY total DESC) AS rn FROM orders',
		'SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
		'DELETE FROM orders WHERE status = \'x\' RETURNING id',
		'SELECT 1 FROM dual',
		'UPDATE orders o SET total = 0 FROM users u WHERE u.id = o.user_id',
		'SELECT o.id, o.\nFROM orders o\nWHERE o.total > 0',
	];
	for (const sql of valid) {
		assert.deepEqual(problems(sql), [], sql);
	}
	assert.deepEqual(problems('SELECT * FROM users WHERE `id` = 1', 'mysql'), []);
});

test('* expands to the columns of the tables it stands for', () => {
	const expand = (sql: string, at = sql.indexOf('*')) => {
		const found = expandStar(catalog, sql, at, 'postgres');
		return found && sql.slice(0, found.start) + found.text + sql.slice(found.start + found.length);
	};
	assert.equal(expand('SELECT * FROM users'), 'SELECT id, email, name FROM users');
	assert.equal(expand('SELECT u.* FROM users u JOIN orders o ON true'), 'SELECT u.id, u.email, u.name FROM users u JOIN orders o ON true');
	assert.equal(expand('SELECT * FROM users u JOIN orders o ON true'), 'SELECT u.id, u.email, u.name, o.id, o.user_id, o.total, o.status FROM users u JOIN orders o ON true');
	assert.equal(expand('WITH r AS (SELECT id, total AS t FROM orders) SELECT * FROM r'), 'WITH r AS (SELECT id, total AS t FROM orders) SELECT id, t FROM r');
	assert.equal(expand('SELECT count(*) FROM users'), undefined);
	assert.equal(expand('SELECT * FROM generate_series(1, 2)'), undefined);
});
