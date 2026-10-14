import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { create as mysql } from '../assist/mysql';
import { create as postgres } from '../assist/postgres';
import type { Catalog, TableInfo } from '../catalog';
import { smartSuggestions, wordStart } from '../console/smart';

const table = (name: string, columns: [string, string, boolean?][], extra: Partial<TableInfo> = {}): TableInfo => ({
	name, kind: 'table', keys: [], foreignKeys: [], indexes: [],
	columns: columns.map(([column, type, generated]) => ({ name: column, type, nullable: true, generated })),
	...extra,
});

const catalog: Catalog = {
	databases: [{
		name: 'shop',
		schemas: [
			{
				name: 'public',
				tables: [
					table('users', [['id', 'integer', true], ['email', 'text'], ['name', 'text']], { keys: [{ name: 'users_pkey', columns: ['id'], primary: true }] }),
					table('orders', [['id', 'integer', true], ['user_id', 'integer'], ['total', 'numeric']], {
						foreignKeys: [{ name: 'orders_user_fk', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
					}),
				],
				objects: [
					{ type: 'function', name: 'total_of', schema: 'public', detail: '(uid integer) → numeric' },
					{ type: 'function', name: 'now_utc', schema: 'public', detail: '() → timestamp' },
					{ type: 'procedure', name: 'archive', schema: 'public', detail: '()' },
				],
			},
			{ name: 'audit', tables: [table('log', [['at', 'timestamp'], ['message', 'text']])] },
		],
	}],
};

const pg = postgres();
const my = mysql();

function suggest(text: string, engine = pg, flavor: 'postgres' | 'mysql' = 'postgres'): { label: string; kind: string; insert: string }[] {
	const offset = text.indexOf('▮');
	const statement = text.replace('▮', '');
	const before = statement.slice(0, offset);
	return smartSuggestions(catalog, engine.analyze(statement, wordStart(before)), statement, before, flavor);
}

const labels = (text: string, kind?: string): string[] => suggest(text).filter(s => !kind || s.kind === kind).map(s => s.label);

test('after a table the grammar keywords come first, WHERE before the rest', () => {
	assert.equal(labels('SELECT * FROM users WH▮', 'keyword')[0], 'WHERE');
	assert.deepEqual(labels('SELECT * FROM users ▮', 'keyword').slice(0, 3), ['WHERE', 'JOIN', 'LEFT JOIN']);
});

test('aliases, CTEs and subqueries resolve to their columns', () => {
	assert.deepEqual(labels('SELECT u.▮ FROM users u', 'column'), ['id', 'email', 'name']);
	assert.deepEqual(labels('SELECT u.em▮ FROM users u', 'column'), ['id', 'email', 'name']);
	assert.deepEqual(labels('WITH recent AS (SELECT id, total FROM orders) SELECT r.▮ FROM recent r', 'column'), ['id', 'total']);
	assert.deepEqual(labels('SELECT * FROM (SELECT id, email AS mail FROM users) x WHERE x.▮', 'column'), ['id', 'mail']);
	assert.deepEqual(labels('SELECT * FROM audit.▮'), ['log']);
});

test('expressions offer the columns of every table in scope, then functions once a word is typed', () => {
	const items = suggest('SELECT ▮ FROM users u JOIN orders o ON o.user_id = u.id');
	assert.deepEqual(items.filter(s => s.kind === 'column').map(s => s.label), ['id', 'email', 'name', 'id', 'user_id', 'total']);
	assert.deepEqual(items.filter(s => s.label === 'id').map(s => s.insert), ['u.id', 'o.id']);
	assert.ok(!items.some(s => s.kind === 'function'));
	assert.ok(suggest('SELECT co▮ FROM users').some(s => s.kind === 'function' && s.label === 'count'));
});

test('keywords are the common ones that fit the clause', () => {
	assert.deepEqual(labels('SELECT * FROM users WHERE email ▮', 'keyword').slice(0, 7), ['AND', 'OR', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN']);
	assert.ok(!labels('SELECT * FROM users WHERE email ▮', 'keyword').some(k => k === 'WHERE' || k.endsWith('JOIN')));
	assert.deepEqual(labels('SELECT * FROM users ORDER BY id ▮', 'keyword').slice(0, 4), ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']);
	assert.deepEqual(labels('SELECT * FROM ▮', 'keyword'), []);
	assert.ok(!labels('SELECT * FROM users WHERE ▮', 'keyword').some(k => /^(BIGINT|ARRAY|XMLPARSE|CURRENT_CATALOG)$/.test(k)));
	assert.ok(!labels('SELECT ▮', 'keyword').includes('WHERE'));
	assert.ok(!labels('SELECT * FROM users u ▮', 'keyword').includes('AS'));
	assert.deepEqual(labels('SELECT * FROM users WHERE name = 1 AND email IS ▮').slice(0, 2), ['NULL', 'NOT NULL']);
	assert.deepEqual(labels('SELECT * FROM users WHERE email IS NOT ▮').slice(0, 1), ['NULL']);
	assert.deepEqual(labels('SELECT * FROM users WHERE email IS NOT N▮').slice(0, 1), ['NULL']);
	assert.ok(labels('SELECT * FROM users ▮', 'keyword').includes('AS'));
	assert.ok(labels('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders ▮', 'keyword').includes('WHERE'));
	assert.ok(!suggest('SELECT * FROM users WHERE ▮', my, 'mysql').some(s => s.label === 'VALUES' || s.label === 'KW_SESSION_VARIABLES_ADMIN'));
});

test('table positions offer tables and schemas', () => {
	const items = labels('SELECT * FROM ▮');
	assert.ok(items.includes('users') && items.includes('audit.log') && items.includes('audit'));
});

test('a join offers the condition from the foreign key', () => {
	assert.equal(suggest('SELECT * FROM users u JOIN orders o ▮')[0].label, 'ON o.user_id = u.id');
	assert.equal(suggest('SELECT * FROM orders o JOIN users u ON ▮')[0].label, 'u.id = o.user_id');
});

test('INSERT and UPDATE offer the columns of their table', () => {
	const insert = suggest('INSERT INTO users (▮');
	assert.deepEqual(insert[0], { label: 'email, name', insert: 'email, name', kind: 'column', detail: 'all columns', sort: '0' });
	assert.deepEqual(suggest('INSERT INTO users (email, ▮').map(s => s.label), ['id', 'name']);
	assert.deepEqual(suggest('UPDATE users SET name = 1, ▮').map(s => s.insert), ['email = ', 'name = ']);
});

test('MySQL resolves aliases with its own grammar', () => {
	assert.deepEqual(suggest('SELECT u.▮ FROM users u', my, 'mysql').filter(s => s.kind === 'column').map(s => s.label), ['id', 'email', 'name']);
	assert.equal(suggest('SELECT * FROM users ▮', my, 'mysql').filter(s => s.kind === 'keyword')[0].label, 'WHERE');
});

test('catalog functions are suggested after a letter', () => {
	const found = suggest('SELECT tot▮ FROM orders').filter(s => s.kind === 'function' && s.label !== 'count');
	assert.deepEqual(found.find(s => s.label === 'total_of')?.insert, 'total_of($1)');
	assert.deepEqual(suggest('SELECT now▮').find(s => s.label === 'now_utc')?.insert, 'now_utc()');
	assert.equal(suggest('SELECT arch▮').some(s => s.label === 'archive'), false);
});
