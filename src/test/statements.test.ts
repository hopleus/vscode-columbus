import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { splitStatements, statementAt } from '../shared/statements';

test('splitStatements ignores semicolons in strings, identifiers and comments', () => {
	const text = `SELECT ';' AS a, "x;y" FROM t; -- note; here\nUPDATE t SET b = 'it''s;' /* ; */ WHERE id = 1;\n\n  -- only a comment;\n`;
	assert.deepEqual(splitStatements(text, 'postgres').map(s => s.text), [
		`SELECT ';' AS a, "x;y" FROM t`,
		`-- note; here\nUPDATE t SET b = 'it''s;' /* ; */ WHERE id = 1`,
	]);
});

test('splitStatements understands dollar quoting in PostgreSQL', () => {
	const text = 'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT $$a;b$$';
	assert.deepEqual(splitStatements(text, 'postgres').map(s => s.text), [
		'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql',
		'SELECT $$a;b$$',
	]);
});

test('splitStatements follows MySQL quoting and comments', () => {
	const text = "SELECT \"a;\\\"b\", `c;d` FROM t # x;y\n; SELECT 'e\\';f'";
	assert.deepEqual(splitStatements(text, 'mysql').map(s => s.text), [
		"SELECT \"a;\\\"b\", `c;d` FROM t # x;y",
		"SELECT 'e\\';f'",
	]);
});

test('statementAt picks the statement under or right before the caret', () => {
	const text = 'SELECT 1;\nSELECT 2; \n\nSELECT 3';
	const ranges = splitStatements(text, 'postgres');
	assert.equal(statementAt(ranges, text, 3)?.text, 'SELECT 1');
	assert.equal(statementAt(ranges, text, 9)?.text, 'SELECT 1');
	assert.equal(statementAt(ranges, text, text.indexOf('2; ') + 3)?.text, 'SELECT 2');
	assert.equal(statementAt(ranges, text, text.indexOf('\n\nSELECT 3') + 1)?.text, 'SELECT 3');
	assert.equal(statementAt(ranges, text, text.length)?.text, 'SELECT 3');
	assert.equal(statementAt([], '', 0), undefined);
});
