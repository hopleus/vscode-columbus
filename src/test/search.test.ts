import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { searchPattern } from '../shared/search';

const plain = { matchCase: false, words: false, regex: false };

test('plain search ignores case and treats the query literally', () => {
	const pattern = searchPattern('a.b', plain);
	assert.ok(pattern?.test('xA.Bx'));
	assert.equal(pattern?.test('axb'), false);
	assert.equal(searchPattern('', plain), undefined);
});

test('match case and whole words narrow the search', () => {
	assert.equal(searchPattern('Pay', { ...plain, matchCase: true })?.test('payment'), false);
	const words = searchPattern('pay', { ...plain, words: true });
	assert.equal(words?.test('payment'), false);
	assert.ok(words?.test('to pay now'));
	assert.ok(words?.test('pay-out'));
	assert.equal(searchPattern('плат', { ...plain, words: true })?.test('платёж'), false);
});

test('regex search uses the query as a pattern and rejects broken ones', () => {
	assert.ok(searchPattern('^\\d{3}$', { ...plain, regex: true })?.test('935'));
	assert.throws(() => searchPattern('(', { ...plain, regex: true }));
});
