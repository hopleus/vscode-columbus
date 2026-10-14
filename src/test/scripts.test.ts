import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mysql, postgres } from '../drivers/sql';
import {
	addColumnSnippet, createIndexSnippet, createTableSnippet, deleteSnippet, dropConstraint, dropIndex, dropTable, insertSnippet,
	dropObject, refreshMaterializedView, renameColumn, renameTable, selectSnippet, updateSnippet,
} from '../explorer/scripts';

const ref = { database: 'shop', schema: 'public', table: 'users' };
const columns = [{ name: 'id', generated: true }, { name: 'email', generated: false }, { name: 'total$', generated: false }];

test('statement snippets list columns and escape snippet syntax', () => {
	assert.equal(selectSnippet(postgres, ref, columns), 'SELECT "id", "email", "total\\$"\nFROM "public"."users"\nWHERE ${1:TRUE};');
	assert.equal(insertSnippet(postgres, ref, columns), 'INSERT INTO "public"."users" ("email", "total\\$")\nVALUES (${1:email}, ${2:total\\$});');
	assert.equal(updateSnippet(mysql, ref, columns, ['id']), 'UPDATE `public`.`users`\nSET `email` = ${1:email},\n    `total\\$` = ${2:total\\$}\nWHERE `id` = ${3:id};');
	assert.equal(updateSnippet(postgres, ref, columns.slice(1, 2), []), 'UPDATE "public"."users"\nSET "email" = ${1:email}\nWHERE ${2:condition};');
	assert.equal(deleteSnippet(postgres, ref, ['id']), 'DELETE FROM "public"."users"\nWHERE "id" = ${1:id};');
	assert.equal(addColumnSnippet(postgres, ref), 'ALTER TABLE "public"."users"\n    ADD COLUMN ${1:name} ${2:text};');
	assert.equal(createIndexSnippet(postgres, ref), 'CREATE INDEX ${1:users_idx}\n    ON "public"."users" (${2:column});');
	assert.match(createTableSnippet(mysql, 'shop'), /^CREATE TABLE `shop`\.\$\{1:table_name\}\n\(\n {4}id bigint AUTO_INCREMENT PRIMARY KEY,/);
});

test('structure statements follow the dialect', () => {
	assert.equal(renameTable(postgres, ref, 'view', 'people'), 'ALTER VIEW "public"."users" RENAME TO "people"');
	assert.equal(renameTable(mysql, ref, 'table', 'people'), 'RENAME TABLE `public`.`users` TO `public`.`people`');
	assert.equal(renameColumn(postgres, ref, 'email', 'mail'), 'ALTER TABLE "public"."users" RENAME COLUMN "email" TO "mail"');
	assert.equal(dropTable(postgres, ref, 'table'), 'DROP TABLE "public"."users"');
	assert.equal(renameTable(postgres, ref, 'materialized view', 'people'), 'ALTER MATERIALIZED VIEW "public"."users" RENAME TO "people"');
	assert.equal(dropTable(postgres, ref, 'materialized view'), 'DROP MATERIALIZED VIEW "public"."users"');
	assert.equal(refreshMaterializedView(postgres, ref), 'REFRESH MATERIALIZED VIEW "public"."users"');
	assert.equal(dropObject(postgres, { type: 'function', name: 'f', schema: 'public', signature: 'public.f(integer)' }), 'DROP FUNCTION public.f(integer)');
	assert.equal(dropObject(mysql, { type: 'procedure', name: 'p', schema: 'shop' }), 'DROP PROCEDURE `shop`.`p`');
	assert.equal(dropObject(postgres, { type: 'domain', name: 'd', schema: 'public' }), 'DROP DOMAIN "public"."d"');
	assert.equal(dropObject(postgres, { type: 'trigger', name: 't', schema: 'public', table: 'orders' }), 'DROP TRIGGER "t" ON "public"."orders"');
	assert.equal(dropObject(mysql, { type: 'trigger', name: 't', schema: 'shop', table: 'orders' }), 'DROP TRIGGER `shop`.`t`');
	assert.equal(dropObject(postgres, { type: 'check', name: 'c', schema: 'public', table: 'orders' }), 'ALTER TABLE "public"."orders" DROP CONSTRAINT "c"');
	assert.equal(dropObject(postgres, { type: 'role', name: 'app' }), 'DROP ROLE "app"');
	assert.equal(dropConstraint(mysql, ref, 'PRIMARY', 'primaryKey'), 'ALTER TABLE `public`.`users` DROP PRIMARY KEY');
	assert.equal(dropConstraint(mysql, ref, 'fk', 'foreignKey'), 'ALTER TABLE `public`.`users` DROP FOREIGN KEY `fk`');
	assert.equal(dropConstraint(postgres, ref, 'users_email_key', 'key'), 'ALTER TABLE "public"."users" DROP CONSTRAINT "users_email_key"');
	assert.equal(dropIndex(postgres, ref, 'users_idx'), 'DROP INDEX "public"."users_idx"');
	assert.equal(dropIndex(mysql, ref, 'users_idx'), 'DROP INDEX `users_idx` ON `public`.`users`');
});
