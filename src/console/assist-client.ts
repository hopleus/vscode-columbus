import { Worker } from 'node:worker_threads';
import type * as vscode from 'vscode';
import type { Analysis } from '../assist/engine';
import type { DriverFiles } from '../drivers/files';
import type { Flavor } from '../shared/format';

const TIMEOUT = 600;

interface Pending {
	resolve(analysis: Analysis | undefined): void;
	timer: NodeJS.Timeout;
}

export class AssistClient implements vscode.Disposable {
	private readonly workers = new Map<Flavor, Promise<Worker>>();
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;

	constructor(private readonly files: DriverFiles, private readonly workerPath: string) { }

	warm(flavor: Flavor): void {
		this.worker(flavor).catch(() => undefined);
	}

	async analyze(flavor: Flavor, statement: string, offset: number): Promise<Analysis | undefined> {
		const started = Date.now();
		const worker = await Promise.race([
			this.worker(flavor).catch(() => undefined),
			new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), TIMEOUT)),
		]);
		if (!worker) {
			return undefined;
		}
		const id = ++this.nextId;
		return new Promise(resolve => {
			const timer = setTimeout(() => this.settle(id, undefined), Math.max(0, TIMEOUT - (Date.now() - started)));
			this.pending.set(id, { resolve, timer });
			worker.postMessage({ id, statement, offset });
		});
	}

	dispose(): void {
		for (const worker of this.workers.values()) {
			void worker.then(w => w.terminate(), () => undefined);
		}
		this.workers.clear();
		for (const id of [...this.pending.keys()]) {
			this.settle(id, undefined);
		}
	}

	private settle(id: number, analysis: Analysis | undefined): void {
		const pending = this.pending.get(id);
		if (pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.resolve(analysis);
		}
	}

	private worker(flavor: Flavor): Promise<Worker> {
		let worker = this.workers.get(flavor);
		if (!worker) {
			worker = this.files.assist(flavor).then(module => {
				const started = new Worker(this.workerPath, { workerData: { module } });
				started.on('message', (message: { id: number; result?: Analysis }) => this.settle(message.id, message.result));
				started.on('error', () => this.workers.delete(flavor));
				started.on('exit', () => this.workers.delete(flavor));
				started.unref();
				return started;
			});
			worker.catch(() => this.workers.delete(flavor));
			this.workers.set(flavor, worker);
		}
		return worker;
	}
}
