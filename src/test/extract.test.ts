import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extract } from '../shared/extract';
import { sqlLiteral } from '../shared/format';

const target = { columns: ['id', 'name', 'note'], table: '"public"."users"', flavor: 'postgres' as const };
const rows = [[1, 'Alice', 'says "hi", then\nleaves'], [2, null, 'a|b']];

test('csv quotes only what needs quoting and skips the header when copying', () => {
	assert.equal(extract('csv', target, rows), 'id,name,note\n1,Alice,"says ""hi"", then\nleaves"\n2,,a|b\n');
	assert.equal(extract('csv', target, [[1, 'x', 'y']], false), '1,x,y\n');
	assert.equal(extract('tsv', target, [[1, 'a\tb', null]], false), '1\t"a\tb"\t\n');
});

test('json writes an array of objects', () => {
	assert.deepEqual(JSON.parse(extract('json', target, rows)), [
		{ id: 1, name: 'Alice', note: 'says "hi", then\nleaves' },
		{ id: 2, name: null, note: 'a|b' },
	]);
	assert.deepEqual(JSON.parse(extract('json', target, [])), []);
});

test('sql inserts use the dialect literals', () => {
	assert.equal(
		extract('sql', target, [[2, null, "it's"]]),
		`INSERT INTO "public"."users" (id, name, note) VALUES (2, NULL, 'it''s');\n`
	);
	assert.equal(
		extract('sql', { ...target, table: '`shop`.`users`', flavor: 'mysql', columns: ['my id'] }, [['a\\b']]),
		"INSERT INTO `shop`.`users` (`my id`) VALUES ('a\\\\b');\n"
	);
});

test('markdown escapes pipes and new lines', () => {
	assert.equal(extract('markdown', target, rows.slice(1)), '| id | name | note |\n| --- | --- | --- |\n| 2 |  | a\\|b |\n');
});

test('sqlLiteral formats every value type', () => {
	assert.equal(sqlLiteral(null, 'postgres'), 'NULL');
	assert.equal(sqlLiteral(true, 'mysql'), 'TRUE');
	assert.equal(sqlLiteral(1.5, 'postgres'), '1.5');
	assert.equal(sqlLiteral("O'Neil \\", 'postgres'), "'O''Neil \\'");
	assert.equal(sqlLiteral("O'Neil \\", 'mysql'), "'O''Neil \\\\'");
});
