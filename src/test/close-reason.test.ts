import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { closeReason } from '../worker/close-reason';

const closing = (after: number, reason = 'SSH connection to h:22 was closed') => (listener: (reason: string) => void): void => {
	setTimeout(() => listener(reason), after);
};

test('a dropped connection reports why the SSH tunnel closed', async () => {
	for (const message of ['read ECONNRESET', 'write EPIPE', 'Connection terminated unexpectedly', 'Connection lost: The server closed the connection.', 'Connection is closed.']) {
		assert.equal(await closeReason(message, closing(20)), 'SSH connection to h:22 was closed', message);
	}
});

test('other errors are reported at once', async () => {
	const started = Date.now();
	assert.equal(await closeReason('syntax error at or near "selec"', closing(20)), undefined);
	assert.ok(Date.now() - started < 20);
});

test('without a tunnel the error stays as it is', async () => {
	assert.equal(await closeReason('read ECONNRESET', undefined), undefined);
});

test('a tunnel that stays open does not hold the error for long', async () => {
	const started = Date.now();
	assert.equal(await closeReason('read ECONNRESET', () => undefined, 50), undefined);
	assert.ok(Date.now() - started < 500);
});
