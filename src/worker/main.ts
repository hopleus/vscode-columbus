import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import type { ConnectionConfig } from '../drivers/connection';
import type { Driver } from '../drivers/driver';
import { closeReason } from './close-reason';
import type { WorkerCall, WorkerData, WorkerRequest, WorkerResponse } from './protocol';

const { module, config, tunnel } = workerData as WorkerData;
const load = createRequire(__filename);
type Address = { host: string; port: number };
type Forward = Address & {
	forward(host: string, port: number): Promise<Address>;
	failure(): string | undefined;
	onClose(listener: (reason: string) => void): void;
};
type Factory = { create(config: ConnectionConfig, options?: { forward?(host: string, port: number): Promise<Address> }): Driver };

let tunnelled: Forward | undefined;
let lost: string | undefined;

async function connectDriver(): Promise<Driver> {
	const factory = load(module) as Factory;
	if (!config.ssh) {
		return factory.create(config);
	}
	if (!tunnel) {
		throw new Error('SSH tunnel files are missing: download the driver files again');
	}
	const opened = await (load(tunnel) as { open(config: ConnectionConfig): Promise<Forward> }).open(config);
	tunnelled = opened;
	opened.onClose(reason => {
		lost = reason;
		setImmediate(() => {
			throw new Error(reason);
		});
	});
	if (config.driver === 'redis' && config.mode) {
		return factory.create({ ...config, servername: config.host }, { forward: (host, port) => opened.forward(host, port) });
	}
	return factory.create({ ...config, host: opened.host, port: opened.port, servername: config.host });
}

let failing = false;
process.on('uncaughtException', err => {
	if (failing) {
		return;
	}
	failing = true;
	const opened = tunnelled;
	const reason = lost ? Promise.resolve(lost) : closeReason(err.message, opened && (listener => opened.onClose(listener)));
	void reason.then(reason => {
		process.removeAllListeners('uncaughtException');
		process.nextTick(() => {
			throw reason ? new Error(reason) : err;
		});
	});
});

let ready: Promise<Driver> | undefined;

async function call(request: WorkerCall): Promise<unknown> {
	if (!ready) {
		ready = connectDriver();
		ready.catch(() => {
			ready = undefined;
		});
	}
	const driver = await ready;
	switch (request.method) {
		case 'version':
			return driver.version();
		case 'catalog':
			return driver.catalog(request.params?.databases);
		case 'select':
			return driver.select(request.params);
		case 'count':
			return driver.count(request.params.table, request.params.where, request.params.session);
		case 'apply':
			return driver.apply(request.params.table, request.params.changes, request.params.session);
		case 'preview':
			return driver.preview(request.params.table, request.params.changes);
		case 'ddl':
			return driver.ddl(request.params.table);
		case 'definition':
			return driver.definition(request.params.object);
		case 'openCursor':
			return driver.openCursor(request.params);
		case 'fetchCursor':
			return driver.fetchCursor(request.params.id, request.params.limit);
		case 'closeCursor':
			return driver.closeCursor(request.params.id);
		case 'execute':
			return driver.execute(request.params.sql, request.params.session, request.params.database);
		case 'cancel':
			return driver.cancel(request.params.key);
		case 'commit':
			return driver.commit(request.params.session);
		case 'rollback':
			return driver.rollback(request.params.session);
		case 'invoke':
			return Promise.resolve((driver as unknown as Record<string, (...args: unknown[]) => unknown>)[request.params.name](...request.params.args));
	}
}

parentPort?.on('message', async (request: WorkerRequest) => {
	let response: WorkerResponse;
	try {
		response = { id: request.id, result: await call(request) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const opened = tunnelled;
		const reason = lost ?? await closeReason(message, opened && (listener => opened.onClose(listener)));
		const failure = tunnelled?.failure();
		response = { id: request.id, error: reason ?? (failure && !message.includes(failure) ? `${message} (${failure})` : message) };
	}
	parentPort?.postMessage(response);
});
