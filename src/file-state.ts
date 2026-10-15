import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';

async function refuseLink(target: string): Promise<void> {
	try {
		if ((await fs.promises.lstat(target)).isSymbolicLink()) {
			throw new Error(`Columbus: ${target} is a symbolic link`);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
}

function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function assign(data: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined) {
		delete data[key];
	} else {
		data[key] = value;
	}
}

export class FileState implements vscode.Memento {
	private readonly file: string;
	private data: Record<string, unknown> = {};
	private readonly pending = new Map<string, unknown>();
	private queue: Promise<void> = Promise.resolve();
	private broken = false;
	private stamp: string | undefined;

	constructor(private readonly root: string, private readonly project = false) {
		this.file = path.join(root, 'state.json');
		this.refresh();
	}

	exists(): boolean {
		return fs.existsSync(this.file);
	}

	private refresh(): void {
		let stamp: string;
		let text: string;
		try {
			const stat = fs.statSync(this.file);
			stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
			if (stamp === this.stamp) {
				return;
			}
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return;
		}
		this.stamp = stamp;
		const parsed = parseObject(text);
		if (!parsed) {
			this.broken = true;
			return;
		}
		this.broken = false;
		this.data = parsed;
		for (const [key, value] of this.pending) {
			assign(this.data, key, value);
		}
	}

	keys(): readonly string[] {
		this.refresh();
		return Object.keys(this.data);
	}

	get<T>(key: string, defaultValue?: T): T | undefined {
		this.refresh();
		return key in this.data ? this.data[key] as T : defaultValue;
	}

	update(key: string, value: unknown): Thenable<void> {
		this.refresh();
		assign(this.data, key, value);
		this.pending.set(key, value);
		const write = async (): Promise<void> => {
			if (this.project) {
				await refuseLink(this.root);
			}
			await fs.promises.mkdir(this.root, { recursive: true });
			if (this.project) {
				await refuseLink(this.file);
				await fs.promises.writeFile(path.join(this.root, '.gitignore'), '*\n', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
					if (err.code !== 'EEXIST') {
						throw err;
					}
				});
			}
			this.refresh();
			const written = new Map(this.pending);
			if (this.broken) {
				await fs.promises.rename(this.file, `${this.file}.bak`).catch((err: NodeJS.ErrnoException) => {
					if (err.code !== 'ENOENT') {
						throw err;
					}
				});
				this.broken = false;
			}
			const temp = path.join(this.root, `state.${randomUUID()}.tmp`);
			try {
				await fs.promises.writeFile(temp, JSON.stringify(this.data, null, '\t'), { flag: 'wx' });
				await fs.promises.rename(temp, this.file);
			} catch (err) {
				await fs.promises.rm(temp, { force: true });
				throw err;
			}
			for (const [key, value] of written) {
				if (this.pending.get(key) === value) {
					this.pending.delete(key);
				}
			}
		};
		this.queue = this.queue.then(write, write);
		return this.queue;
	}
}

export function importLegacy(legacy: vscode.Memento, target: FileState): void {
	if (target.exists()) {
		return;
	}
	for (const key of legacy.keys()) {
		if (key.startsWith('columbus.')) {
			void target.update(key, legacy.get(key));
		}
	}
}
