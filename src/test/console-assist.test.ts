import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Catalog, TableInfo } from '../catalog';
import { consoleSuggestions, shouldPopup, tableReferences } from '../console/assist';

const table = (name: string, columns: string[], kind: 'table' | 'view' = 'table'): TableInfo => ({
	name, kind, keys: [], foreignKeys: [], indexes: [],
	columns: columns.map(c => ({ name: c, type: 'text', nullable: true })),
});

const catalog: Catalog = {
	databases: [{
		name: 'shop',
		schemas: [
			{ name: 'public', tables: [table('users', ['id', 'email']), table('orders', ['id', 'user_id', 'total']), table('active users', ['id'], 'view')] },
			{ name: 'audit', tables: [table('log', ['at', 'message'])] },
		],
	}],
};

function labels(statement: string, caret = statement.length): string[] {
	return consoleSuggestions(catalog, statement, statement.slice(0, caret), 'postgres').map(s => s.label);
}

test('tableReferences collects tables and aliases from FROM, JOIN and comma lists', () => {
	const references = tableReferences('SELECT * FROM users u, audit.log l JOIN public.orders AS o ON o.user_id = u.id WHERE 1');
	assert.deepEqual(Object.fromEntries(references), {
		users: ['users'],
		u: ['users'],
		orders: ['public', 'orders'],
		o: ['public', 'orders'],
		log: ['audit', 'log'],
		l: ['audit', 'log'],
	});
	assert.deepEqual([...tableReferences('select * from users where id = 1').keys()], ['users']);
});

test('after a table keyword the console offers tables and schemas', () => {
	assert.deepEqual(labels('SELECT * FROM '), ['users', 'orders', 'active users', 'audit.log', 'audit']);
	const view = consoleSuggestions(catalog, 'UPDATE ', 'UPDATE ', 'postgres').find(s => s.label === 'active users');
	assert.deepEqual([view?.insert, view?.kind], ['"active users"', 'view']);
});

test('after an alias or a table and a dot the console offers its columns', () => {
	assert.deepEqual(labels('SELECT o. FROM orders o', 'SELECT o.'.length), ['id', 'user_id', 'total']);
	assert.deepEqual(labels('SELECT * FROM audit.'), ['log']);
	assert.deepEqual(labels('SELECT l.me FROM audit.log l', 'SELECT l.me'.length), ['at', 'message']);
	assert.deepEqual(labels('SELECT missing.'), []);
});

test('in expressions the console offers columns of referenced tables first, then functions and keywords', () => {
	const suggestions = consoleSuggestions(catalog, 'SELECT  FROM users', 'SELECT ', 'postgres');
	assert.deepEqual(suggestions.slice(0, 2).map(s => [s.label, s.detail, s.sort]), [['id', 'users.text', '0'], ['email', 'users.text', '0']]);
	const count = suggestions.find(s => s.label === 'count');
	assert.deepEqual([count?.kind, count?.insert, count?.snippet], ['function', 'count(*)', true]);
	const where = consoleSuggestions(catalog, 'SELECT * FROM users WHERE id = 1 AND ', 'SELECT * FROM users WHERE id = 1 AND ', 'postgres');
	assert.ok(where.some(s => s.label === 'IS NOT NULL' && s.insert === 'IS NOT NULL'));
	assert.ok(where.some(s => s.label === 'email'));
});

test('at the start of a statement the console offers statement keywords', () => {
	assert.deepEqual(labels('').slice(0, 4), ['SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM']);
	assert.ok(labels('SELE').includes('SELECT'));
	assert.ok(consoleSuggestions(catalog, '', '', 'mysql').some(s => s.label === 'SHOW TABLES'));
	const select = consoleSuggestions(catalog, '', '', 'postgres')[0];
	assert.deepEqual([select.insert, select.retrigger], ['SELECT ', true]);
});

test('after a table the console offers the clauses that can follow it', () => {
	assert.deepEqual(labels('SELECT * FROM users u ').slice(0, 3), ['WHERE', 'JOIN', 'LEFT JOIN']);
	assert.deepEqual(labels('SELECT * FROM users JOIN orders o ').slice(0, 2), ['ON', 'USING']);
	assert.deepEqual(labels('UPDATE users '), ['SET']);
	assert.deepEqual(labels('INSERT INTO users ').slice(0, 2), ['VALUES', 'SELECT']);
	assert.ok(labels('SELECT * FROM users WHERE ').includes('email'));
});

test('shouldPopup opens the list where there is something to offer', () => {
	const popup = (before: string): boolean => shouldPopup(before, 'postgres', consoleSuggestions(catalog, before, before, 'postgres'));
	assert.equal(popup('SELECT * FROM account WH'), true);
	assert.equal(popup('SELECT * FROM '), true);
	assert.equal(popup('SELECT * FROM users '), true);
	assert.equal(popup('SELECT * FROM users WHERE '), true);
	assert.equal(popup('SELECT * FROM users WHERE id = 1 AND '), true);
	assert.equal(shouldPopup('SELECT u.', 'postgres', consoleSuggestions(catalog, 'SELECT u. FROM users u', 'SELECT u.', 'postgres')), true);
	assert.equal(popup('SELECT u.'), false);
	assert.equal(popup('SELECT * FROM users WHERE id = '), false);
	assert.equal(popup('SELECT * FROM users WHERE id = 12'), false);
	assert.equal(popup('SELECT * FROM users WHERE'), false);
	assert.equal(popup('SELECT * FROM users WHERE id = 1 AND zzz'), false);
	const listed = (before: string): boolean => shouldPopup(before, 'postgres', [{ label: 'id', insert: 'id', kind: 'column', detail: '', sort: '0' }]);
	assert.equal(listed('INSERT INTO users ('), true);
	assert.equal(listed('INSERT INTO "public".users (id, '), true);
	assert.equal(listed('INSERT INTO users (id) VALUES ('), false);
	assert.equal(listed('SELECT 1, '), false);
	assert.equal(listed('SELECT * FROM t WHERE a IS '), true);
	assert.equal(listed('SELECT * FROM t WHERE a IS NOT '), true);
});
