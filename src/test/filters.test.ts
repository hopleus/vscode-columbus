import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { addCondition, filterCondition } from '../shared/filters';

test('filterCondition builds conditions from a cell value', () => {
	assert.equal(filterCondition('equals', 'entity_name', 'payment', 'postgres'), "entity_name = 'payment'");
	assert.equal(filterCondition('equals', 'name', null, 'postgres'), 'name IS NULL');
	assert.equal(filterCondition('notEquals', 'user id', "O'Neil", 'postgres'), `"user id" <> 'O''Neil'`);
	assert.equal(filterCondition('greater', 'total', '99.50', 'mysql'), "total > '99.50'");
	assert.equal(filterCondition('less', 'active', true, 'postgres'), 'active < TRUE');
	assert.equal(filterCondition('notNull', 'meta', 'x', 'mysql'), 'meta IS NOT NULL');
});

test('contains escapes LIKE wildcards and casts in PostgreSQL', () => {
	assert.equal(filterCondition('contains', 'id', 42, 'postgres'), "id::text LIKE '%42%'");
	assert.equal(filterCondition('contains', 'note', '50%_off\\', 'postgres'), "note::text LIKE '%50\\%\\_off\\\\%'");
	assert.equal(filterCondition('contains', 'note', '50%', 'mysql'), "note LIKE '%50\\\\%%'");
});

test('addCondition keeps the existing filter', () => {
	assert.equal(addCondition('', 'a = 1'), 'a = 1');
	assert.equal(addCondition(' x > 1 OR y ', 'a = 1'), '(x > 1 OR y) AND a = 1');
});
