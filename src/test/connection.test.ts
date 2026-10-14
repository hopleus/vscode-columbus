import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatUrl, parseUrl, productOf } from '../drivers/connection';

test('parseUrl reads every part of a postgres URL', () => {
	assert.deepEqual(parseUrl('postgres', 'postgresql://app%40corp:p%2Fss@db.local:5433/my%20db?sslmode=require'), {
		driver: 'postgres',
		host: 'db.local',
		port: 5433,
		database: 'my db',
		user: 'app@corp',
		password: 'p/ss',
		ssl: 'require',
	});
});

test('parseUrl fills defaults', () => {
	const config = parseUrl('postgres', 'postgres://admin@localhost');
	assert.equal(config.port, 5432);
	assert.equal(config.database, 'admin');
	assert.equal(config.password, '');
	assert.equal(config.ssl, 'disable');
	assert.equal(parseUrl('postgres', 'postgres://[::1]:5432/db').host, '::1');
});

test('parseUrl rejects other schemes and unknown ssl modes', () => {
	assert.throws(() => parseUrl('postgres', 'mysql://localhost/db'), /must start with postgresql:\/\/ or postgres:\/\//);
	assert.throws(() => parseUrl('postgres', 'localhost:5432'), /must start with|Expected a URL/);
	assert.throws(() => parseUrl('postgres', 'postgres://localhost/db?sslmode=maybe'), /Unknown sslmode/);
});

test('parseUrl reads MySQL and MariaDB URLs', () => {
	assert.deepEqual(parseUrl('mysql', 'mysql://root@localhost'), {
		driver: 'mysql',
		host: 'localhost',
		port: 3306,
		database: '',
		user: 'root',
		password: '',
		ssl: 'disable',
	});
	const config = parseUrl('mysql', 'mariadb://app:secret@db:3307/shop?ssl-mode=REQUIRED');
	assert.equal(config.database, 'shop');
	assert.equal(config.port, 3307);
	assert.equal(config.ssl, 'require');
	assert.equal(parseUrl('mysql', 'mysql://h/db?sslmode=VERIFY_IDENTITY').ssl, 'verify-full');
	assert.throws(() => parseUrl('mysql', 'postgres://h/db'), /must start with mysql:\/\/ or mariadb:\/\//);
});

test('formatUrl writes what parseUrl reads, without the password', () => {
	for (const url of ['postgresql://app%40corp@db.local:5433/my%20db?sslmode=require', 'mysql://root@[::1]:3306', 'mysql://localhost:3307/shop?sslmode=verify-full']) {
		const kind = url.startsWith('mysql') ? 'mysql' : 'postgres';
		const { password, ...config } = parseUrl(kind, url);
		assert.equal(password, '');
		assert.equal(formatUrl(config), url);
	}
	const { password, ...config } = parseUrl('postgres', 'postgres://u:secret@h/db');
	assert.equal(password, 'secret');
	assert.equal(formatUrl(config), 'postgresql://u@h:5432/db');
});

test('productOf tells the server from its version', () => {
	assert.equal(productOf('PostgreSQL 18.0'), 'postgres');
	assert.equal(productOf('MySQL 8.0.39'), 'mysql');
	assert.equal(productOf('MariaDB 11.4.3'), 'mariadb');
	assert.equal(productOf('Valkey 8.1.4'), 'valkey');
	assert.equal(productOf('Dragonfly 2.0.2'), 'dragonfly');
	assert.equal(productOf('Redis 7.4.2'), 'redis');
	assert.equal(productOf('Demo'), undefined);
});

test('certificate files and verify-ca travel in PostgreSQL and MySQL URLs', () => {
	const pg = parseUrl('postgres', 'postgresql://app@db.local/shop?sslmode=verify-ca&sslrootcert=/etc/ssl/ca.pem&sslcert=~/client.crt&sslkey=~/client.key');
	assert.deepEqual([pg.ssl, pg.sslCa, pg.sslCert, pg.sslKey], ['verify-ca', '/etc/ssl/ca.pem', '~/client.crt', '~/client.key']);
	assert.equal(formatUrl(pg), 'postgresql://app@db.local:5432/shop?sslmode=verify-ca&sslrootcert=/etc/ssl/ca.pem&sslcert=~/client.crt&sslkey=~/client.key');
	const mysql = parseUrl('mysql', 'mysql://root@db.local/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=/etc/ssl/ca.pem');
	assert.deepEqual([mysql.ssl, mysql.sslCa], ['verify-full', '/etc/ssl/ca.pem']);
	assert.equal(formatUrl(mysql), 'mysql://root@db.local:3306/app?sslmode=verify-full&ssl-ca=/etc/ssl/ca.pem');
	assert.equal(formatUrl({ ...mysql, ssl: 'disable' }), 'mysql://root@db.local:3306/app');
	assert.equal(parseUrl('redis', 'rediss://cache.local?sslmode=verify-ca').ssl, 'verify-ca');
	assert.equal(formatUrl({ ...parseUrl('redis', 'rediss://cache.local'), ssl: 'verify-ca', sslCa: '/etc/ssl/ca.pem' }), 'rediss://cache.local:6379/0?sslmode=verify-ca');
});
