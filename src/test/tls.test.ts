import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseUrl } from '../drivers/connection';
import type { ConnectionConfig, DriverKind, SslMode } from '../drivers/connection';
import { MysqlDriver } from '../drivers/mysql';
import { PostgresDriver } from '../drivers/postgres';
import { RedisDriver } from '../drivers/redis';

const ca = process.env.COLUMBUS_TLS_CA;
const clientCert = process.env.COLUMBUS_TLS_CLIENT_CERT;
const clientKey = process.env.COLUMBUS_TLS_CLIENT_KEY;
const skip = !ca && 'start test/tls.sh and set its variables';

const SERVERS: [DriverKind, string | undefined][] = [
	['postgres', process.env.COLUMBUS_TLS_PG_URL],
	['mysql', process.env.COLUMBUS_TLS_MYSQL_URL],
	['redis', process.env.COLUMBUS_TLS_REDIS_URL],
];

async function version(config: ConnectionConfig): Promise<string> {
	const driver = config.driver === 'postgres' ? new PostgresDriver(config) : config.driver === 'mysql' ? new MysqlDriver(config) : new RedisDriver(config);
	try {
		return await driver.version();
	} finally {
		driver.dispose();
	}
}

const target = (driver: DriverKind, url: string, ssl: SslMode, extra: Partial<ConnectionConfig> = {}): ConnectionConfig =>
	({ ...parseUrl(driver, url), ssl, ...extra });

for (const [driver, url] of SERVERS) {
	test(`${driver}: the CA file verifies the server certificate and its host name`, { skip }, async () => {
		assert.match(await version(target(driver, url!, 'verify-full', { sslCa: ca })), /\d/);
		await assert.rejects(version(target(driver, url!, 'verify-full')), /self[- ]signed certificate|unable to (get|verify)/i);
		await assert.rejects(version(target(driver, url!, 'verify-full', { sslCa: ca, host: 'localhost' })), /localhost.*altnames|altnames.*localhost/i);
		assert.match(await version(target(driver, url!, 'verify-ca', { sslCa: ca, host: 'localhost' })), /\d/);
		await assert.rejects(version(target(driver, url!, 'verify-ca', { host: 'localhost' })), /self[- ]signed certificate|unable to (get|verify)/i);
		assert.match(await version(target(driver, url!, 'require')), /\d/);
		await assert.rejects(version(target(driver, url!, 'verify-full', { sslCa: join(ca!, '..', 'missing.crt') })), /^Error: SSL: cannot read the CA file \S+missing\.crt \(not found\)$/);
	});
}

const CLIENTS: [DriverKind, string | undefined][] = [
	['postgres', process.env.COLUMBUS_TLS_PG_URL?.replace('postgres:columbus@', 'columbus@')],
	['mysql', process.env.COLUMBUS_TLS_MYSQL_URL?.replace('root:', 'columbus:')],
	['redis', process.env.COLUMBUS_TLS_REDIS_CLIENT_URL],
];

for (const [driver, url] of CLIENTS) {
	test(`${driver}: the client certificate signs in`, { skip }, async () => {
		assert.match(await version(target(driver, url!, 'verify-full', { sslCa: ca, sslCert: clientCert, sslKey: clientKey })), /\d/);
		await assert.rejects(version(target(driver, url!, 'verify-full', { sslCa: ca })));
		const locked = join(clientKey!, '..', 'columbus-locked.key');
		assert.match(await version(target(driver, url!, 'verify-full', { sslCa: ca, sslCert: clientCert, sslKey: locked, sslPassphrase: 'secret' })), /\d/);
		await assert.rejects(version(target(driver, url!, 'verify-full', { sslCa: ca, sslCert: clientCert, sslKey: locked, sslPassphrase: 'wrong' })), { message: `SSL: wrong passphrase for the client key ${locked}` });
		await assert.rejects(version(target(driver, url!, 'verify-full', { sslCa: ca, sslCert: clientCert, sslKey: locked })), { message: `SSL: the client key ${locked} is protected by a passphrase` });
	});
}
