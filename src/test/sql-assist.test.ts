import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { suggest, tokenize, wordAt } from '../shared/sql-assist';
import type { GridColumn } from '../shared/protocol';

const column = (name: string, type = 'text'): GridColumn => ({
	name, type, primary: false, foreign: false, numeric: false, nullable: true, generated: false, hasDefault: false,
});
const columns = [column('id', 'integer'), column('email'), column('created at', 'timestamp')];
const names = columns.map(c => c.name);

function kinds(text: string, flavor: 'postgres' | 'mysql' = 'postgres'): string[] {
	return tokenize(text, flavor, names).filter(t => t.kind !== 'space').map(t => `${t.kind}:${t.text}`);
}

test('tokenize tells columns, keywords, functions, strings and numbers apart', () => {
	assert.deepEqual(kinds(`lower(email) LIKE '%it''s%' AND id >= 10.5 -- note`), [
		'function:lower', 'operator:(', 'column:email', 'operator:)', 'keyword:LIKE', "string:'%it''s%'",
		'keyword:AND', 'column:id', 'operator:>=', 'number:10.5', 'comment:-- note',
	]);
	assert.deepEqual(kinds('"created at" IS NOT NULL AND other IN (1, 2)'), [
		'column:"created at"', 'keyword:IS', 'keyword:NOT', 'keyword:NULL', 'keyword:AND', 'identifier:other',
		'keyword:IN', 'operator:(', 'number:1', 'operator:,', 'number:2', 'operator:)',
	]);
});

test('tokenize follows the dialect quoting rules', () => {
	assert.deepEqual(kinds('`created at` = "x\\"y" # comment', 'mysql'), [
		'column:`created at`', 'operator:=', 'string:"x\\"y"', 'comment:# comment',
	]);
	assert.deepEqual(kinds('EMAIL = 1', 'postgres'), ['column:EMAIL', 'operator:=', 'number:1']);
	assert.deepEqual(kinds("name = 'open", 'postgres'), ['identifier:name', 'operator:=', "string:'open"]);
});

test('tokens cover the whole text', () => {
	const text = `a /* x */ = 'b' || c::text`;
	assert.equal(tokenize(text, 'postgres', names).map(t => t.text).join(''), text);
});

test('wordAt finds the word before the caret and stays quiet inside strings', () => {
	assert.deepEqual(wordAt('id = 1 AND em', 13, 'postgres'), { start: 11, prefix: 'em' });
	assert.deepEqual(wordAt('id = ', 5, 'postgres'), { start: 5, prefix: '' });
	assert.equal(wordAt("name = 'em", 10, 'postgres'), undefined);
	assert.equal(wordAt('x = 12', 6, 'postgres'), undefined);
	assert.deepEqual(wordAt("name = 'em' AND i", 17, 'postgres'), { start: 16, prefix: 'i' });
});

test('suggest ranks columns first, then keywords and functions', () => {
	assert.deepEqual(suggest('', 'where', 'postgres', columns).map(s => s.label), ['id', 'email', 'created at']);
	assert.deepEqual(suggest('i', 'where', 'postgres', columns).map(s => s.label), ['id', 'IS NULL', 'IS NOT NULL', 'IN', 'ILIKE']);
	assert.deepEqual(suggest('ai', 'where', 'postgres', columns).map(s => s.label), ['email']);
	assert.deepEqual(suggest('at', 'where', 'postgres', columns).map(s => s.insert), ['"created at"', 'date_trunc()']);
	assert.deepEqual(suggest('d', 'order', 'mysql', columns).map(s => s.label), ['DESC']);
	assert.deepEqual(suggest('low', 'where', 'mysql', columns).map(s => [s.insert, s.caret]), [['lower()', 1]]);
	assert.deepEqual(suggest('nul', 'order', 'postgres', columns).map(s => s.label), ['NULLS FIRST', 'NULLS LAST']);
});
