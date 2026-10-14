import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { display, formatOrder, parseOrder } from '../shared/format';
import type { GridColumn } from '../shared/protocol';

const column = (extra: Partial<GridColumn> = {}): GridColumn => ({
	name: 'c', type: 'text', primary: false, foreign: false, numeric: false, nullable: true, generated: false, hasDefault: false, ...extra,
});

test('display marks null and unset cells as muted', () => {
	assert.deepEqual(display(null, column()), { text: '<null>', muted: true });
	assert.deepEqual(display(undefined, column({ generated: true })), { text: '<generated>', muted: true });
	assert.deepEqual(display(undefined, column({ hasDefault: true })), { text: '<default>', muted: true });
	assert.deepEqual(display('a\nb', column()), { text: 'a↵b', muted: false });
	assert.deepEqual(display(0, column()), { text: '0', muted: false });
});

test('formatOrder quotes only identifiers that need it', () => {
	assert.equal(formatOrder([{ column: 'id', desc: false }, { column: 'created at', desc: true }], '"'), 'id, "created at" DESC');
	assert.equal(formatOrder([{ column: 'a`b', desc: false }], '`'), '`a``b`');
});

test('parseOrder reads what formatOrder writes', () => {
	const sort = [{ column: 'id', desc: true }, { column: 'created at', desc: false }, { column: 'x"y', desc: true }];
	assert.deepEqual(parseOrder(formatOrder(sort, '"')), sort);
	assert.deepEqual(parseOrder('`name` asc'), [{ column: 'name', desc: false }]);
});

test('parseOrder gives up on expressions', () => {
	assert.deepEqual(parseOrder('lower(name)'), []);
	assert.deepEqual(parseOrder(''), []);
});
