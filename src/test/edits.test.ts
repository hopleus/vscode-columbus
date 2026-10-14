import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Edits } from '../shared/edits';
import type { GridColumn } from '../shared/protocol';

const column = (name: string, primary = false): GridColumn => ({
	name, type: 'text', primary, foreign: false, numeric: false, nullable: true, generated: false, hasDefault: false,
});

const columns = [column('id', true), column('name'), column('email')];
const rows = () => [[1, 'Alice', 'a@x.io'], [2, 'Bob', null], [3, 'Carol', 'c@x.io']];

test('update keeps the original key and only changed columns', () => {
	const edits = new Edits(rows());
	edits.set(1, 1, 'Robert');
	edits.set(1, 2, 'b@x.io');
	assert.equal(edits.state(1), 'updated');
	assert.equal(edits.value(1, 1), 'Robert');
	assert.deepEqual(edits.changes(columns), [{ kind: 'update', key: { id: 2 }, values: { name: 'Robert', email: 'b@x.io' } }]);
});

test('setting the original value back clears the update', () => {
	const edits = new Edits(rows());
	edits.set(0, 1, 'Alicia');
	edits.set(0, 1, 'Alice');
	assert.equal(edits.dirty, false);
	assert.equal(edits.state(0), 'clean');
});

test('removed rows produce deletes and drop their updates', () => {
	const edits = new Edits(rows());
	edits.set(2, 1, 'Caroline');
	edits.remove([2]);
	assert.equal(edits.state(2), 'removed');
	assert.deepEqual(edits.changes(columns), [{ kind: 'delete', key: { id: 3 } }]);
});

test('added rows insert only the cells that were set', () => {
	const edits = new Edits(rows());
	const row = edits.add();
	assert.equal(row, 3);
	assert.equal(edits.value(row, 0), undefined);
	edits.set(row, 1, 'Dave');
	assert.equal(edits.isModified(row, 1), true);
	assert.deepEqual(edits.changes(columns), [{ kind: 'insert', values: { name: 'Dave' } }]);
});

test('removing or reverting an added row drops it', () => {
	const edits = new Edits(rows());
	edits.add();
	edits.add();
	edits.remove([3]);
	assert.equal(edits.rowCount, 4);
	edits.revert([3]);
	assert.equal(edits.rowCount, 3);
	assert.equal(edits.dirty, false);
});

test('revert restores updated and removed rows', () => {
	const edits = new Edits(rows());
	edits.set(0, 1, 'Alicia');
	edits.remove([1]);
	edits.revert([0, 1]);
	assert.equal(edits.dirty, false);
	assert.equal(edits.value(0, 1), 'Alice');
});

test('tables without a primary key use every column as the key', () => {
	const edits = new Edits(rows());
	edits.remove([1]);
	const plain = columns.map(c => ({ ...c, primary: false }));
	assert.deepEqual(edits.changes(plain), [{ kind: 'delete', key: { id: 2, name: 'Bob', email: null } }]);
});

test('SQL expressions travel apart from values', () => {
	const withTime = [column('id', true), column('name'), column('updated_at')];
	const edits = new Edits([[1, 'Ann', null]]);
	edits.set(0, 1, 'Anna');
	edits.setExpression(0, 2, 'now()');
	assert.equal(edits.isExpression(0, 2), true);
	assert.equal(edits.value(0, 2), 'now()');
	const added = edits.add();
	edits.setExpression(added, 2, 'DEFAULT');
	edits.set(added, 1, 'Bob');
	assert.deepEqual(edits.changes(withTime), [
		{ kind: 'update', key: { id: 1 }, values: { name: 'Anna' }, expressions: { updated_at: 'now()' } },
		{ kind: 'insert', values: { name: 'Bob' }, expressions: { updated_at: 'DEFAULT' } },
	]);
	edits.set(0, 2, 'plain');
	assert.equal(edits.isExpression(0, 2), false);
});
