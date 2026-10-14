import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { collection, commandLine, commandsFor, parseCommand, replyRows } from '../redis/values';

test('collections become grid rows with a key column', () => {
	const hash = collection({ type: 'hash', entries: [['a', '1']], hex: [], total: 1, ttl: -1 })!;
	assert.deepEqual([hash.columns.map(c => `${c.name}${c.primary ? '*' : ''}`), hash.rows], [['field*', 'value'], [['a', '1']]]);
	assert.deepEqual(collection({ type: 'list', items: ['x', 'y'], hex: [], total: 2, ttl: -1 })!.rows, [[0, 'x'], [1, 'y']]);
	assert.deepEqual(collection({ type: 'zset', entries: [['ann', '1.5']], hex: [], total: 1, ttl: -1 })!.rows, [['ann', 1.5]]);
	assert.deepEqual(collection({ type: 'stream', entries: [['1-1', [['k', 'v']]]], total: 1, ttl: -1 })!.rows, [['1-1', '{"k":"v"}']]);
	assert.deepEqual(collection({ type: 'string', value: 'x', binary: false, ttl: -1 })!.rows, [['x']]);
	const blob = collection({ type: 'string', value: '0x00ff', binary: true, ttl: -1 })!.columns[0];
	assert.deepEqual([blob.type, blob.generated], ['binary', false]);
	assert.equal(collection({ type: 'none' }), undefined);
});

test('grid changes become Redis commands', () => {
	const hashRows = [['email', 'a@b'], ['name', 'Ann']];
	assert.deepEqual(commandsFor('hash', 'u', [
		{ kind: 'update', key: { field: 'email' }, values: { value: 'x@y' } },
		{ kind: 'update', key: { field: 'name' }, values: { field: 'title' } },
		{ kind: 'insert', values: { field: 'age', value: '3' } },
		{ kind: 'delete', key: { field: 'old' } },
	], hashRows), [['HSET', 'u', 'email', 'x@y'], ['HDEL', 'u', 'name'], ['HSET', 'u', 'title', 'Ann'], ['HSET', 'u', 'age', '3'], ['HDEL', 'u', 'old']]);
	const list = commandsFor('list', 'q', [
		{ kind: 'update', key: { index: 0 }, values: { value: 'z' } },
		{ kind: 'delete', key: { index: 2 } },
		{ kind: 'insert', values: { value: 'w' } },
	], []);
	assert.deepEqual(list.slice(0, 1), [['LSET', 'q', '0', 'z']]);
	assert.equal(list[1][0], 'LSET');
	assert.deepEqual(list[2], ['RPUSH', 'q', 'w']);
	assert.deepEqual(list[3].slice(0, 3), ['LREM', 'q', '0']);
	assert.equal(list[3][3], list[1][3]);
	assert.deepEqual(commandsFor('set', 's', [{ kind: 'update', key: { member: 'a' }, values: { member: 'b' } }], []), [['SREM', 's', 'a'], ['SADD', 's', 'b']]);
	assert.deepEqual(commandsFor('zset', 'z', [{ kind: 'update', key: { member: 'ann' }, values: { score: 5 } }], [['ann', 1]]), [['ZADD', 'z', '5', 'ann']]);
	assert.throws(() => commandsFor('stream', 'e', [{ kind: 'insert', values: { id: 'x' } }], []), /only be deleted/);
	assert.deepEqual(commandsFor('string', 'k', [{ kind: 'update', key: { value: 'a' }, values: { value: 'b' } }], []), [['SET', 'k', 'b', 'KEEPTTL']]);
	assert.deepEqual(commandsFor('json', 'j', [{ kind: 'update', key: {}, values: { value: '{"a":1}' } }], []), [['JSON.SET', 'j', '$', '{"a":1}']]);
	assert.throws(() => commandsFor('string', 'k', [{ kind: 'delete', key: { value: 'a' } }], []), /holds one value/);
	const [binary] = commandsFor('string', 'k', [{ kind: 'update', key: { value: '0x00' }, values: { value: '0x00ff10' } }], [], new Set(['value']));
	assert.deepEqual([binary[2] instanceof Uint8Array, [...binary[2] as Uint8Array]], [true, [0, 255, 16]]);
	assert.equal(commandLine(binary), 'SET k "\\x00\\xff\\x10" KEEPTTL');
	assert.deepEqual(commandsFor('string', 'k', [{ kind: 'update', key: { value: '0x00' }, values: { value: 'plain text' } }], [], new Set(['value'])), [['SET', 'k', 'plain text', 'KEEPTTL']]);
});

test('console lines split into arguments like redis-cli', () => {
	assert.deepEqual(parseCommand('SET  greeting "hello \\"world\\"\\n" EX 10'), ['SET', 'greeting', 'hello "world"\n', 'EX', '10']);
	assert.deepEqual(parseCommand("HSET h 'it\\'s' x"), ['HSET', 'h', "it's", 'x']);
	assert.throws(() => parseCommand('GET "open'), /Unbalanced/);
	assert.equal(commandLine(['SET', 'a b', 'x"y']), 'SET "a b" "x\\"y"');
});

test('replies become rows', () => {
	assert.deepEqual(replyRows(['GET', 'k'], 'v'), { columns: ['value'], rows: [['v']] });
	assert.deepEqual(replyRows(['HGETALL', 'h'], ['a', '1', 'b', '2']), { columns: ['field', 'value'], rows: [['a', '1'], ['b', '2']] });
	assert.deepEqual(replyRows(['ZRANGE', 'z', '0', '-1', 'WITHSCORES'], ['ann', '1']), { columns: ['member', 'score'], rows: [['ann', '1']] });
	assert.deepEqual(replyRows(['LRANGE', 'q', '0', '-1'], ['a', 'b']), { columns: ['#', 'value'], rows: [[1, 'a'], [2, 'b']] });
	assert.deepEqual(replyRows(['SCAN', '0'], ['17', ['k1', 'k2']]), { columns: ['cursor', 'value'], rows: [['17', 'k1'], ['17', 'k2']] });
	assert.deepEqual(replyRows(['XRANGE', 'e', '-', '+'], [['1-1', ['k', 'v']]]), { columns: ['#', 'value'], rows: [[1, '["1-1",["k","v"]]']] });
});
