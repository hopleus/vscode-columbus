import { Worker } from 'node:worker_threads';
import type { Catalog, ObjectInfo, TableRef } from '../catalog';
import type { Flavor } from '../shared/format';
import type { Change } from '../shared/protocol';
import type { WorkerCall, WorkerData, WorkerResponse } from '../worker/protocol';
import { TRUST } from './connection';
import type { ConnectionConfig } from './connection';
import type { CursorPage, CursorRequest, Driver, ExecuteResult, SelectRequest, SelectResult } from './driver';
import type { RedisArg, RedisCommandDoc, RedisDatabase, RedisKey, RedisReply, RedisValue } from './redis';

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	method: WorkerCall['method'];
}

const SERVER_CALLS = new Set<WorkerCall['method']>(['version', 'catalog', 'select', 'count', 'apply', 'ddl', 'execute', 'invoke']);

export interface WorkerExtras {
	tunnel?(): Promise<string>;
	trust?(host: string, fingerprint: string, changed: boolean): Promise<boolean>;
}

export class WorkerClient {
	private worker: Promise<Worker> | undefined;
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private connected = false;
	private trusting: Promise<boolean> | undefined;

	constructor(
		private readonly workerPath: string,
		private readonly modulePath: () => Promise<string>,
		private readonly config: () => Promise<ConnectionConfig>,
		private readonly onConnection?: (connected: boolean) => void,
		private readonly extras: WorkerExtras = {}
	) { }

	version(): Promise<string> {
		return this.call({ method: 'version' }) as Promise<string>;
	}

	disconnect(): void {
		this.dispose();
	}

	dispose(): void {
		const worker = this.worker;
		this.worker = undefined;
		void worker?.then(w => w.terminate(), () => undefined);
		this.fail(new Error('The data source was disconnected'));
		this.setConnected(false);
	}

	protected async call(request: WorkerCall, retried = false): Promise<unknown> {
		const worker = await this.start();
		const id = ++this.nextId;
		try {
			return await new Promise((resolve, reject) => {
				this.pending.set(id, { resolve, reject, method: request.method });
				worker.postMessage({ ...request, id });
			});
		} catch (err) {
			const untrusted = TRUST.exec((err as Error).message);
			if (!untrusted || retried || !this.extras.trust || !await this.confirm(untrusted)) {
				throw err;
			}
			return this.call(request, true);
		}
	}

	private confirm([, host, port, changed, fingerprint]: RegExpExecArray): Promise<boolean> {
		this.trusting ??= this.extras.trust!(`${host}:${port}`, fingerprint, !!changed).then(trusted => {
			if (trusted) {
				const worker = this.worker;
				this.worker = undefined;
				void worker?.then(w => w.terminate(), () => undefined);
			}
			return trusted;
		}).finally(() => {
			this.trusting = undefined;
		});
		return this.trusting;
	}

	private start(): Promise<Worker> {
		this.worker ??= Promise.all([this.modulePath(), this.config()]).then(async ([module, config]) => {
			const tunnel = config.ssh ? await this.extras.tunnel?.() : undefined;
			const data: WorkerData = { module, config, ...(tunnel ? { tunnel } : {}) };
			const worker = new Worker(this.workerPath, { workerData: data });
			worker.on('message', (response: WorkerResponse) => {
				const pending = this.pending.get(response.id);
				this.pending.delete(response.id);
				if (response.error !== undefined) {
					pending?.reject(new Error(response.error));
				} else {
					if (pending && SERVER_CALLS.has(pending.method)) {
						this.setConnected(true);
					}
					pending?.resolve(response.result);
				}
			});
			worker.on('error', err => this.crashed(worker, err));
			worker.on('exit', code => this.crashed(worker, new Error(`The driver stopped with exit code ${code}`)));
			worker.unref();
			return worker;
		});
		this.worker.catch(() => {
			this.worker = undefined;
		});
		return this.worker;
	}

	private crashed(worker: Worker, error: Error): void {
		void this.worker?.then(current => {
			if (current === worker) {
				this.worker = undefined;
				this.fail(error);
				this.setConnected(false);
			}
		}, () => undefined);
	}

	private setConnected(connected: boolean): void {
		if (this.connected !== connected) {
			this.connected = connected;
			this.onConnection?.(connected);
		}
	}

	private fail(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export class RemoteDriver extends WorkerClient implements Driver {
	constructor(
		readonly flavor: Flavor,
		workerPath: string,
		modulePath: () => Promise<string>,
		config: () => Promise<ConnectionConfig>,
		onConnection?: (connected: boolean) => void,
		extras?: WorkerExtras
	) {
		super(workerPath, modulePath, config, onConnection, extras);
	}

	catalog(databases?: string[]): Promise<Catalog> {
		return this.call({ method: 'catalog', params: { databases } }) as Promise<Catalog>;
	}

	select(request: SelectRequest): Promise<SelectResult> {
		return this.call({ method: 'select', params: request }) as Promise<SelectResult>;
	}

	count(table: TableRef, where: string, session?: string): Promise<number> {
		return this.call({ method: 'count', params: { table, where, session } }) as Promise<number>;
	}

	async apply(table: TableRef, changes: Change[], session?: string): Promise<void> {
		await this.call({ method: 'apply', params: { table, changes, session } });
	}

	preview(table: TableRef, changes: Change[]): Promise<string> {
		return this.call({ method: 'preview', params: { table, changes } }) as Promise<string>;
	}

	ddl(table: TableRef): Promise<string> {
		return this.call({ method: 'ddl', params: { table } }) as Promise<string>;
	}

	definition(object: ObjectInfo): Promise<string> {
		return this.call({ method: 'definition', params: { object } }) as Promise<string>;
	}

	openCursor(request: CursorRequest): Promise<string> {
		return this.call({ method: 'openCursor', params: request }) as Promise<string>;
	}

	fetchCursor(id: string, limit: number): Promise<CursorPage> {
		return this.call({ method: 'fetchCursor', params: { id, limit } }) as Promise<CursorPage>;
	}

	async closeCursor(id: string): Promise<void> {
		await this.call({ method: 'closeCursor', params: { id } });
	}

	execute(sql: string, session: string, database?: string): Promise<ExecuteResult[]> {
		return this.call({ method: 'execute', params: { sql, session, database } }) as Promise<ExecuteResult[]>;
	}

	async commit(session: string): Promise<void> {
		await this.call({ method: 'commit', params: { session } });
	}

	async rollback(session: string): Promise<void> {
		await this.call({ method: 'rollback', params: { session } });
	}

	cancel(key: string): Promise<boolean> {
		return this.call({ method: 'cancel', params: { key } }) as Promise<boolean>;
	}
}

export class RemoteRedis extends WorkerClient {
	databases(): Promise<RedisDatabase[]> {
		return this.invoke('databases');
	}

	scan(db: number, pattern: string, limit: number): Promise<{ keys: RedisKey[]; complete: boolean }> {
		return this.invoke('scan', db, pattern, limit);
	}

	value(db: number, key: RedisArg, limit: number): Promise<RedisValue> {
		return this.invoke('value', db, key, limit);
	}

	setString(db: number, key: RedisArg, value: string): Promise<void> {
		return this.invoke('setString', db, key, value);
	}

	batch(db: number, commands: RedisArg[][]): Promise<RedisReply[]> {
		return this.invoke('batch', db, commands);
	}

	command(db: number, args: RedisArg[]): Promise<RedisReply> {
		return this.invoke('command', db, args);
	}

	execute(session: string, db: number, args: string[]): Promise<{ reply: RedisReply; db: number }> {
		return this.invoke('execute', session, db, args);
	}

	commands(): Promise<RedisCommandDoc[]> {
		return this.invoke('commands');
	}

	cancel(session: string): Promise<boolean> {
		return this.invoke('cancel', session);
	}

	release(session: string): Promise<void> {
		return this.invoke('release', session);
	}

	private invoke<T>(name: string, ...args: unknown[]): Promise<T> {
		return this.call({ method: 'invoke', params: { name, args } }) as Promise<T>;
	}
}
