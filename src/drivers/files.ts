import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { DRIVERS } from './connection';
import type { DriverKind } from './connection';
import type { Flavor } from '../shared/format';
import { cached, download, entryOf, forget, previous, sha256, store } from './install';
import type { DriverFile, DriverManifest } from './install';

const BUNDLES: Record<DriverKind, string[]> = {
	postgres: ['postgres', 'assist-postgres', 'ssh'],
	mysql: ['mysql', 'assist-mysql', 'ssh'],
	sqlite: ['sqlite', 'assist-postgres'],
	redis: ['redis', 'ssh'],
};

const LOCAL: Record<string, string> = {
	postgres: 'drivers/postgres.js',
	mysql: 'drivers/mysql.js',
	redis: 'drivers/redis.js',
	sqlite: 'drivers/sqlite.js',
	ssh: 'drivers/ssh.js',
	'assist-postgres': 'assist/postgres.js',
	'assist-mysql': 'assist/mysql.js',
};

const BUILT_IN: Partial<Record<DriverKind, { library: string; version: string }>> = {
	sqlite: { library: 'SQLite', version: (process.versions as Record<string, string | undefined>).sqlite ?? '' },
};

export function megabytes(size: number): string {
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export class DriverMissingError extends Error {
	constructor(readonly kind: DriverKind, readonly outdated = false) {
		super(`${DRIVERS[kind].label} driver files ${outdated ? 'need an update' : 'are not downloaded'}`);
		this.name = 'DriverMissingError';
	}
}

export interface DriverState {
	kind: DriverKind;
	label: string;
	status: 'ready' | 'outdated' | 'missing';
	library: string;
	version: string;
	previousVersion?: string;
	size: number;
	local: boolean;
}

export class DriverFiles implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<DriverKind>();
	readonly onDidChange = this._onDidChange.event;
	private readonly downloads = new Map<DriverKind, Promise<void>>();
	private readonly offered = new Set<DriverKind>();
	private manifestFile: Promise<DriverManifest> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	private get local(): boolean {
		return this.context.extensionMode !== vscode.ExtensionMode.Production && !process.env.COLUMBUS_RELEASE_URL;
	}

	private get dir(): string {
		return vscode.Uri.joinPath(this.context.globalStorageUri, 'drivers').fsPath;
	}

	private manifest(): Promise<DriverManifest> {
		this.manifestFile ??= readFile(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'drivers.json').fsPath, 'utf8').then(text => JSON.parse(text) as DriverManifest);
		return this.manifestFile;
	}

	private entry(manifest: DriverManifest, key: string): DriverManifest[string] {
		const entry = manifest[key];
		if (!entry) {
			throw new Error(`This build of Columbus has no ${key} driver files`);
		}
		return entry;
	}

	async state(kind: DriverKind): Promise<DriverState> {
		const manifest = await this.manifest().catch(() => ({} as DriverManifest));
		const module = DRIVERS[kind].module;
		const base = {
			kind,
			label: DRIVERS[kind].label,
			local: this.local,
			library: manifest[module]?.library ?? BUILT_IN[kind]?.library ?? module,
			version: manifest[module]?.version ?? BUILT_IN[kind]?.version ?? '',
		};
		if (this.local) {
			return { ...base, status: 'ready', size: 0 };
		}
		const missing: string[] = [];
		for (const key of BUNDLES[kind]) {
			if (!manifest[key] || !await cached(this.dir, key, manifest[key])) {
				missing.push(key);
			}
		}
		const size = missing.reduce((sum, key) => sum + (manifest[key]?.size ?? 0), 0);
		if (!missing.length) {
			return { ...base, status: 'ready', size };
		}
		const old = await this.outdated(manifest, module);
		return old ? { ...base, status: 'outdated', size, previousVersion: old.version } : { ...base, status: 'missing', size };
	}

	private async outdated(manifest: DriverManifest, module: string): Promise<{ version?: string } | undefined> {
		const old = await previous(this.dir, module);
		return old && old.sha256 !== manifest[module]?.sha256 ? old : undefined;
	}

	path(kind: DriverKind, offer = true): Promise<string> {
		return this.file(DRIVERS[kind].module, kind, offer);
	}

	tunnel(kind: DriverKind): Promise<string> {
		return this.file('ssh', kind, false);
	}

	assist(flavor: Flavor): Promise<string> {
		const engine = flavor === 'sqlite' ? 'postgres' : flavor;
		return this.file(`assist-${engine}`, flavor, false);
	}

	private async file(key: string, kind: DriverKind, offer: boolean): Promise<string> {
		if (this.local) {
			return vscode.Uri.joinPath(this.context.extensionUri, 'out', ...LOCAL[key].split('/')).fsPath;
		}
		const existing = await cached(this.dir, key, this.entry(await this.manifest(), key));
		if (existing) {
			return existing;
		}
		if (offer) {
			void this.offer(kind);
		}
		throw new DriverMissingError(kind, (await this.outdated(await this.manifest(), DRIVERS[kind].module)) !== undefined);
	}

	private async offer(kind: DriverKind): Promise<void> {
		if (this.offered.has(kind) || this.downloads.has(kind)) {
			return;
		}
		this.offered.add(kind);
		try {
			const { label, size, status, library, version } = await this.state(kind);
			const outdated = status === 'outdated';
			const answer = await vscode.window.showWarningMessage(
				outdated ? `Columbus: ${label} driver files need an update to ${library} ${version} (${megabytes(size)}).` : `Columbus: ${label} driver files are not downloaded (${megabytes(size)}).`,
				outdated ? 'Update' : 'Download'
			);
			if (answer) {
				await this.download(kind);
			}
		} finally {
			this.offered.delete(kind);
		}
	}

	download(kind: DriverKind): Promise<void> {
		let running = this.downloads.get(kind);
		if (!running) {
			running = this.fetch(kind).finally(() => this.downloads.delete(kind));
			this.downloads.set(kind, running);
		}
		return running;
	}

	private async fetch(kind: DriverKind): Promise<void> {
		if (this.local) {
			return;
		}
		const manifest = await this.manifest();
		const packageJson = this.context.extension.packageJSON as { version: string; repository: { url: string } };
		const base = process.env.COLUMBUS_RELEASE_URL ?? `${packageJson.repository.url.replace(/\.git$/, '')}/releases/download/v${packageJson.version}`;
		const { label, size } = await this.state(kind);
		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Columbus: downloading ${label} driver files (${megabytes(size)})` },
				async () => {
					for (const key of BUNDLES[kind]) {
						const entry = this.entry(manifest, key);
						if (!await cached(this.dir, key, entry)) {
							await download(`${base}/${entry.file}`, this.dir, key, entry);
						}
					}
				}
			);
		} catch (err) {
			throw new Error(`Could not download ${label} driver files: ${(err as Error).message}`);
		}
		this._onDidChange.fire(kind);
	}

	async remove(kind: DriverKind): Promise<void> {
		for (const key of BUNDLES[kind]) {
			await forget(this.dir, key);
		}
		this._onDidChange.fire(kind);
	}

	async install(uris: readonly vscode.Uri[]): Promise<string[]> {
		const manifest = await this.manifest();
		const installed = new Map<string, string>();
		const put = async (key: string, entry: DriverFile, data: Uint8Array): Promise<void> => {
			await store(this.dir, key, entry, data);
			installed.set(key, entry.file);
		};
		for (const uri of uris) {
			const data = await vscode.workspace.fs.readFile(uri);
			const found = entryOf(manifest, data);
			if (!found) {
				throw new Error(`${uri.path.split('/').pop()} is not a driver file of this Columbus version`);
			}
			await put(found[0], found[1], data);
		}
		const folders = [...new Map(uris.map(uri => [vscode.Uri.joinPath(uri, '..').toString(), vscode.Uri.joinPath(uri, '..')])).values()];
		for (const keys of Object.values(BUNDLES).filter(keys => keys.some(key => installed.has(key)))) {
			for (const key of keys) {
				const entry = manifest[key];
				if (!entry || installed.has(key) || await cached(this.dir, key, entry)) {
					continue;
				}
				for (const folder of folders) {
					const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, entry.file)).then(undefined, () => undefined);
					if (data && sha256(data) === entry.sha256) {
						await put(key, entry, data);
						break;
					}
				}
			}
		}
		for (const kind of Object.keys(BUNDLES) as DriverKind[]) {
			this._onDidChange.fire(kind);
		}
		return [...installed.values()];
	}
}
