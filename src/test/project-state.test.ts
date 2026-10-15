import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EXCLUDE_GLOB, withExclude } from '../project-state';

test('hiding adds the folder to files.exclude and keeps other entries', () => {
	assert.deepEqual(withExclude(undefined, true), { [EXCLUDE_GLOB]: true });
	assert.deepEqual(withExclude({ '**/dist': true }, true), { '**/dist': true, [EXCLUDE_GLOB]: true });
	assert.deepEqual(withExclude({ [EXCLUDE_GLOB]: false }, true), { [EXCLUDE_GLOB]: true });
});

test('hiding changes nothing when the folder is already hidden', () => {
	assert.equal(withExclude({ [EXCLUDE_GLOB]: true }, true), undefined);
});

test('showing removes only the folder entry', () => {
	assert.deepEqual(withExclude({ '**/dist': true, [EXCLUDE_GLOB]: true }, false), { '**/dist': true });
	assert.deepEqual(withExclude({ [EXCLUDE_GLOB]: true }, false), {});
	assert.equal(withExclude({ '**/dist': true }, false), undefined);
	assert.equal(withExclude(undefined, false), undefined);
});

test('the input of withExclude is not modified', () => {
	const input = { '**/dist': true };
	withExclude(input, true);
	assert.deepEqual(input, { '**/dist': true });
});
