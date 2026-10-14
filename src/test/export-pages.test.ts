import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { pages } from '../editor/pages';
import type { ExportSource } from '../editor/pages';
import type { Value } from '../shared/protocol';

const source = (cursorPages: { rows: Value[][]; done: boolean }[]): ExportSource & { closed: boolean } => {
	const state = { closed: false };
	return Object.assign(state, {
		title: 't',
		columns: ['id'],
		table: 't',
		flavor: 'postgres' as const,
		fetch: async () => ({ rows: [], more: false }),
		cursor: async () => ({
			next: async () => cursorPages.shift() ?? { rows: [], done: true },
			close: async () => {
				state.closed = true;
			},
		}),
	});
};

test('every cursor page reaches the export, the last one too', async () => {
	const taken: Value[][] = [];
	const firsts: boolean[] = [];
	const export$ = source([{ rows: [['1'], ['2']], done: false }, { rows: [['3']], done: true }]);
	await pages(export$, async (rows, first) => {
		taken.push(...rows);
		firsts.push(first);
		return true;
	});
	assert.deepEqual(taken, [['1'], ['2'], ['3']]);
	assert.deepEqual(firsts, [true, false]);
	assert.equal(export$.closed, true);
});

test('a single page smaller than the page size is exported', async () => {
	const taken: Value[][] = [];
	await pages(source([{ rows: [['only']], done: true }]), async rows => {
		taken.push(...rows);
		return true;
	});
	assert.deepEqual(taken, [['only']]);
});

test('a cancelled export stops after the page in hand and closes the cursor', async () => {
	const export$ = source([{ rows: [['1']], done: false }, { rows: [['2']], done: false }]);
	let calls = 0;
	await pages(export$, async () => ++calls < 1);
	assert.equal(calls, 1);
	assert.equal(export$.closed, true);
});
