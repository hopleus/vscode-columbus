import type * as vscode from 'vscode';
import type { ConnectionConfig, Product, SshConfig } from './drivers/connection';
import type { Secrets } from './shared/form-protocol';

export type StoredSource = Omit<ConnectionConfig, 'password' | 'ssh' | 'servername' | 'sslPassphrase'> & { id: string; name: string; product?: Product; ssh?: Omit<SshConfig, 'password'> };

const KEY = 'columbus.dataSources';
const SOURCE_ID = /^[A-Za-z0-9_-]+$/;

export function isSourceId(id: unknown): id is string {
	return typeof id === 'string' && SOURCE_ID.test(id);
}

export function sslFiles(source: Pick<ConnectionConfig, 'ssl' | 'sslCa' | 'sslCert' | 'sslKey'>): Pick<ConnectionConfig, 'sslCa' | 'sslCert' | 'sslKey'> {
	if (source.ssl === 'disable') {
		return {};
	}
	return {
		...(source.sslCa?.trim() ? { sslCa: source.sslCa.trim() } : {}),
		...(source.sslCert?.trim() ? { sslCert: source.sslCert.trim() } : {}),
		...(source.sslKey?.trim() ? { sslKey: source.sslKey.trim() } : {}),
	};
}

function secretKey(id: string): string {
	return `columbus.password/${id}`;
}

function sshKey(id: string): string {
	return `columbus.sshPassword/${id}`;
}

function sslKeyKey(id: string): string {
	return `columbus.sslKeyPassphrase/${id}`;
}

export class SourceStore {
	constructor(private readonly state: vscode.Memento, private readonly secrets: vscode.SecretStorage) { }

	list(): StoredSource[] {
		const stored = this.state.get<unknown>(KEY, []);
		return Array.isArray(stored) ? (stored as StoredSource[]).filter(s => isSourceId(s?.id)) : [];
	}

	get(id: string): StoredSource | undefined {
		return this.list().find(s => s.id === id);
	}

	async add(source: StoredSource, secrets: Secrets): Promise<void> {
		await this.storeSecrets(source, secrets);
		await this.state.update(KEY, [...this.list(), source]);
	}

	async update(source: StoredSource, secrets: Secrets): Promise<void> {
		await this.storeSecrets(source, secrets);
		await this.state.update(KEY, this.list().map(s => s.id === source.id ? source : s));
	}

	async put(source: StoredSource): Promise<void> {
		await this.state.update(KEY, [...this.list().filter(s => s.id !== source.id), source]);
	}

	async detach(id: string): Promise<void> {
		await this.state.update(KEY, this.list().filter(s => s.id !== id));
	}

	private async storeSecrets(source: StoredSource, secrets: Secrets): Promise<void> {
		const entries: [string, string | undefined, boolean][] = [
			[secretKey(source.id), secrets.password, true],
			[sshKey(source.id), secrets.sshPassword, !!source.ssh && source.ssh.auth !== 'agent'],
			[sslKeyKey(source.id), secrets.sslPassphrase, !!source.sslKey],
		];
		for (const [key, value, used] of entries) {
			if (!used || value === '') {
				await this.secrets.delete(key);
			} else if (value !== undefined) {
				await this.secrets.store(key, value);
			}
		}
	}

	async sslPassphrase(id: string): Promise<string | undefined> {
		return this.secrets.get(sslKeyKey(id));
	}

	async setFingerprint(id: string, fingerprint: string): Promise<void> {
		await this.state.update(KEY, this.list().map(s => (s.id === id && s.ssh ? { ...s, ssh: { ...s.ssh, fingerprint } } : s)));
	}

	async sshPassword(id: string): Promise<string | undefined> {
		return this.secrets.get(sshKey(id));
	}

	async setProduct(id: string, product: Product): Promise<void> {
		await this.state.update(KEY, this.list().map(s => s.id === id ? { ...s, product } : s));
	}

	async password(id: string): Promise<string | undefined> {
		return this.secrets.get(secretKey(id));
	}

	async remove(id: string): Promise<void> {
		await this.detach(id);
		await this.secrets.delete(secretKey(id));
		await this.secrets.delete(sshKey(id));
		await this.secrets.delete(sslKeyKey(id));
	}

	async config(source: StoredSource): Promise<ConnectionConfig> {
		const current = this.get(source.id) ?? source;
		return {
			driver: current.driver,
			host: current.host,
			port: current.port,
			database: current.database,
			user: current.user,
			ssl: current.ssl,
			...sslFiles(current),
			...(current.mode ? { mode: current.mode } : {}),
			...(current.master ? { master: current.master } : {}),
			password: await this.password(current.id) ?? '',
			...(current.ssh ? { ssh: { ...current.ssh, password: await this.sshPassword(current.id) ?? '' } } : {}),
			...(current.sslKey && current.ssl !== 'disable' ? { sslPassphrase: await this.sslPassphrase(current.id) ?? '' } : {}),
		};
	}
}
