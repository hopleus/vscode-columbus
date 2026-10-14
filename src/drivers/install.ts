import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DriverFile {
	file: string;
	sha256: string;
	size: number;
	library?: string;
	version?: string;
}

export type DriverManifest = Record<string, DriverFile>;

export function sha256(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

function cachedName(module: string, entry: DriverFile): string {
	return `${module}-${entry.sha256.slice(0, 16)}.js`;
}

export async function cached(dir: string, module: string, entry: DriverFile): Promise<string | undefined> {
	const path = join(dir, cachedName(module, entry));
	try {
		return sha256(await readFile(path)) === entry.sha256 ? path : undefined;
	} catch {
		return undefined;
	}
}

export async function store(dir: string, module: string, entry: DriverFile, data: Uint8Array): Promise<string> {
	if (sha256(data) !== entry.sha256) {
		throw new Error('The file does not match its checksum');
	}
	await mkdir(dir, { recursive: true });
	const name = cachedName(module, entry);
	const target = join(dir, name);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, data);
	await rename(temporary, target);
	for (const other of await readdir(dir)) {
		if (other.startsWith(`${module}-`) && other !== name) {
			await rm(join(dir, other), { force: true });
		}
	}
	await writeFile(join(dir, `${module}.json`), JSON.stringify({ sha256: entry.sha256, library: entry.library, version: entry.version }));
	return target;
}

export async function previous(dir: string, module: string): Promise<{ sha256: string; library?: string; version?: string } | undefined> {
	try {
		return JSON.parse(await readFile(join(dir, `${module}.json`), 'utf8')) as { sha256: string; library?: string; version?: string };
	} catch {
		return undefined;
	}
}

export async function download(url: string, dir: string, module: string, entry: DriverFile, fetcher: typeof fetch = fetch): Promise<string> {
	const response = await fetcher(url);
	if (!response.ok) {
		throw new Error(`${url} answered ${response.status} ${response.statusText}`.trim());
	}
	const data = new Uint8Array(await response.arrayBuffer());
	if (sha256(data) !== entry.sha256) {
		throw new Error('The downloaded file does not match its checksum');
	}
	return store(dir, module, entry, data);
}

export function entryOf(manifest: DriverManifest, data: Uint8Array): [string, DriverFile] | undefined {
	const hash = sha256(data);
	return Object.entries(manifest).find(([, entry]) => entry.sha256 === hash);
}

export async function forget(dir: string, module: string): Promise<void> {
	try {
		for (const name of await readdir(dir)) {
			if (name.startsWith(`${module}-`) || name === `${module}.json`) {
				await rm(join(dir, name), { force: true });
			}
		}
	} catch {
		return;
	}
}
