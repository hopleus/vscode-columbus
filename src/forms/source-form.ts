import { randomBytes, randomUUID } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import * as vscode from 'vscode';
import { DRIVERS, productOf } from '../drivers/connection';
import type { ConnectionConfig } from '../drivers/connection';
import type { DriverFiles } from '../drivers/files';
import { WorkerClient } from '../drivers/remote';
import type { FormHostMessage, FormViewMessage, Secrets, SourceFields, SslFileField } from '../shared/form-protocol';
import { sslFiles } from '../store';
import type { SourceStore, StoredSource } from '../store';

const SSL_FILE_TITLES: Record<SslFileField, string> = { sslCa: 'CA File', sslCert: 'Client Certificate', sslKey: 'Client Key' };

export interface SourceFormContext {
	extensionUri: vscode.Uri;
	store(global: boolean): SourceStore;
	files: DriverFiles;
	workerPath: string;
	saved(source: StoredSource, created: boolean, global: boolean): void;
}

export function databaseFile(path: string): string {
	const trimmed = path.trim();
	if (trimmed.startsWith('~') || isAbsolute(trimmed)) {
		return trimmed;
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return folder ? join(folder, trimmed) : trimmed;
}

export async function confirmHost(host: string, fingerprint: string, changed: boolean): Promise<boolean> {
	const answer = await vscode.window.showWarningMessage(
		changed ? `The SSH host key of ${host} has changed` : `The authenticity of SSH host ${host} can't be established`,
		{
			modal: true,
			detail: `${changed ? 'Someone could be intercepting the connection, or the server key was replaced. ' : ''}Key fingerprint: ${fingerprint}. Connect and remember this key?`,
		},
		'Trust'
	);
	return answer === 'Trust';
}

function validate(fields: SourceFields): string | undefined {
	if (!fields.name.trim()) {
		return 'Enter a name';
	}
	if (fields.ssh) {
		if (!fields.ssh.host.trim() || !fields.ssh.user.trim()) {
			return 'Enter the SSH host and user';
		}
		if (!Number.isInteger(fields.ssh.port) || fields.ssh.port < 1 || fields.ssh.port > 65535) {
			return 'Enter an SSH port between 1 and 65535';
		}
		if (fields.ssh.auth === 'key' && !fields.ssh.keyFile?.trim()) {
			return 'Choose the SSH private key file';
		}
	}
	if (fields.driver === 'sqlite') {
		return fields.database.trim() ? undefined : 'Choose a database file';
	}
	if (fields.driver === 'redis' && fields.mode === 'sentinel' && !fields.master?.trim()) {
		return 'Enter the name of the master that Sentinel watches';
	}
	if (!fields.host.trim()) {
		return 'Enter a host';
	}
	if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535) {
		return 'Enter a port between 1 and 65535';
	}
	return DRIVERS[fields.driver] ? undefined : 'Choose a driver';
}

export class SourceForm {
	private static readonly open = new Map<string, SourceForm>();

	static show(context: SourceFormContext, global: boolean, existing?: StoredSource): void {
		const key = existing?.id ?? (global ? ':global' : ':project');
		const form = SourceForm.open.get(key);
		if (form) {
			form.panel.reveal();
			return;
		}
		SourceForm.open.set(key, new SourceForm(context, global, existing, () => SourceForm.open.delete(key)));
	}

	static close(id: string): void {
		SourceForm.open.get(id)?.panel.dispose();
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private testing: WorkerClient | undefined;
	private stopped = false;
	private readonly trusted = new Map<string, string>();

	private readonly store: SourceStore;

	private constructor(private readonly context: SourceFormContext, private readonly global: boolean, private readonly existing: StoredSource | undefined, onDispose: () => void) {
		this.store = context.store(global);
		const out = vscode.Uri.joinPath(context.extensionUri, 'out');
		this.panel = vscode.window.createWebviewPanel(
			'columbus.dataSource',
			existing ? `${existing.name} – Data Source` : global ? 'New Global Data Source' : 'New Data Source',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [out] }
		);
		this.panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'icons', 'light', 'source.svg'),
			dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'icons', 'dark', 'source.svg'),
		};
		this.panel.webview.html = this.html(out);
		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((message: FormViewMessage) => this.receive(message)),
			context.files.onDidChange(kind => void this.postDriver(kind)),
			this.panel.onDidDispose(() => {
				onDispose();
				this.testing?.dispose();
				for (const disposable of this.disposables.splice(0)) {
					disposable.dispose();
				}
			})
		);
	}

	private post(message: FormHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private async receive(message: FormViewMessage): Promise<void> {
		switch (message.type) {
			case 'ready': {
				const hasPassword = !!this.existing && !!await this.store.password(this.existing.id);
				const hasSshPassword = !!this.existing && !!await this.store.sshPassword(this.existing.id);
				const hasSslPassphrase = !!this.existing && !!await this.store.sslPassphrase(this.existing.id);
				if (this.existing?.ssh?.fingerprint) {
					this.trusted.set(`${this.existing.ssh.host}:${this.existing.ssh.port}`, this.existing.ssh.fingerprint);
				}
				this.post({ type: 'init', source: this.existing, hasPassword, hasSshPassword, hasSslPassphrase });
				await this.postDriver(this.existing?.driver ?? 'postgres');
				return;
			}
			case 'driverState':
				await this.postDriver(message.kind);
				return;
			case 'downloadDriver': {
				const state = await this.context.files.state(message.kind);
				this.post({ type: 'driver', driver: { ...state, status: 'downloading' } });
				try {
					await this.context.files.download(message.kind);
					await this.postDriver(message.kind);
				} catch (err) {
					this.post({ type: 'driver', driver: { ...state, status: 'failed', error: (err as Error).message } });
				}
				return;
			}
			case 'test':
				this.post({ type: 'tested', requestId: message.requestId, ...await this.test(message.fields, message.secrets) });
				return;
			case 'save':
				await this.save(message.fields, message.secrets, message.force);
				return;
			case 'browseKey': {
				const [picked] = await vscode.window.showOpenDialog({
					title: 'SSH Private Key',
					defaultUri: vscode.Uri.file(message.path.trim() ? message.path.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), '.ssh')),
					canSelectMany: false,
				}) ?? [];
				if (picked) {
					this.post({ type: 'keyFile', path: picked.fsPath });
				}
				return;
			}
			case 'browseSslFile': {
				const [picked] = await vscode.window.showOpenDialog({
					title: SSL_FILE_TITLES[message.field],
					...(message.path.trim() ? { defaultUri: vscode.Uri.file(message.path.trim().replace(/^~(?=\/|$)/, homedir())) } : {}),
					canSelectMany: false,
				}) ?? [];
				if (picked) {
					this.post({ type: 'sslFile', field: message.field, path: picked.fsPath });
				}
				return;
			}
			case 'cancel':
				this.panel.dispose();
				return;
			case 'stop':
				this.stopped = true;
				this.testing?.dispose();
				return;
			case 'createFile': {
				const target = await vscode.window.showSaveDialog({
					title: 'New SQLite Database',
					saveLabel: 'Create',
					defaultUri: message.path.trim() ? vscode.Uri.file(databaseFile(message.path)) : vscode.workspace.workspaceFolders?.[0]?.uri,
					filters: { 'SQLite databases': ['db', 'sqlite', 'sqlite3'] },
				});
				if (target) {
					try {
						await vscode.workspace.fs.stat(target);
					} catch {
						await vscode.workspace.fs.writeFile(target, new Uint8Array());
					}
					this.post({ type: 'file', path: target.fsPath });
				}
				return;
			}
			case 'browse': {
				const current = message.path.trim() ? vscode.Uri.file(databaseFile(message.path)) : vscode.workspace.workspaceFolders?.[0]?.uri;
				const [picked] = await vscode.window.showOpenDialog({
					title: 'SQLite Database File',
					defaultUri: current,
					canSelectMany: false,
					filters: { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'], 'All files': ['*'] },
				}) ?? [];
				if (picked) {
					this.post({ type: 'file', path: picked.fsPath });
				}
				return;
			}
		}
	}

	private async postDriver(kind: SourceFields['driver']): Promise<void> {
		this.post({ type: 'driver', driver: await this.context.files.state(kind) });
	}

	private async test(fields: SourceFields, secrets: Secrets): Promise<{ ok: boolean; message: string }> {
		const problem = validate(fields);
		if (problem) {
			return { ok: false, message: problem };
		}
		const config = await this.config(fields, secrets);
		const driver = new WorkerClient(this.context.workerPath, () => this.context.files.path(fields.driver, false), async () => config, undefined, {
			tunnel: () => this.context.files.tunnel(fields.driver),
			trust: async (host, fingerprint, changed) => {
				if (!await confirmHost(host, fingerprint, changed)) {
					return false;
				}
				this.trusted.set(host, fingerprint);
				if (config.ssh) {
					config.ssh = { ...config.ssh, fingerprint };
				}
				return true;
			},
		});
		this.testing?.dispose();
		this.testing = driver;
		this.stopped = false;
		try {
			return { ok: true, message: await driver.version() };
		} catch (err) {
			return { ok: false, message: this.stopped ? 'Connection test cancelled' : (err as Error).message };
		} finally {
			if (this.testing === driver) {
				this.testing = undefined;
			}
			driver.dispose();
		}
	}

	private async save(fields: SourceFields, secrets: Secrets, force: boolean): Promise<void> {
		const problem = validate(fields);
		if (problem) {
			this.post({ type: 'failed', message: problem, canForce: false });
			return;
		}
		let product = this.existing?.driver === fields.driver ? this.existing.product : undefined;
		if (!force) {
			const result = await this.test(fields, secrets);
			if (!result.ok) {
				this.post({ type: 'failed', message: result.message, canForce: true });
				return;
			}
			product = productOf(result.message) ?? product;
		}
		const source: StoredSource = {
			id: this.existing?.id ?? randomUUID(),
			name: fields.name.trim(),
			driver: fields.driver,
			host: fields.host.trim(),
			port: fields.port,
			database: fields.database.trim(),
			user: fields.user,
			ssl: fields.ssl,
			...sslFiles(fields),
			...(fields.driver === 'redis' && fields.mode ? { mode: fields.mode } : {}),
			...(fields.driver === 'redis' && fields.mode === 'sentinel' && fields.master ? { master: fields.master.trim() } : {}),
			...(product ? { product } : {}),
			...(fields.ssh ? { ssh: this.ssh(fields) } : {}),
		};
		if (this.existing) {
			await this.store.update(source, secrets);
		} else {
			await this.store.add(source, secrets);
		}
		this.context.saved(source, !this.existing, this.global);
		this.panel.dispose();
	}

	private ssh(fields: SourceFields): NonNullable<StoredSource['ssh']> {
		const ssh = fields.ssh!;
		const fingerprint = this.trusted.get(`${ssh.host.trim()}:${ssh.port}`);
		return {
			host: ssh.host.trim(),
			port: ssh.port,
			user: ssh.user.trim(),
			auth: ssh.auth,
			...(ssh.auth === 'key' && ssh.keyFile ? { keyFile: ssh.keyFile.trim() } : {}),
			...(fingerprint ? { fingerprint } : {}),
		};
	}

	private async config(fields: SourceFields, secrets: Secrets): Promise<ConnectionConfig> {
		const store = this.store;
		const id = this.existing?.id;
		const password = secrets.password ?? (id ? await store.password(id) : undefined) ?? '';
		const sshPassword = secrets.sshPassword ?? (id ? await store.sshPassword(id) : undefined) ?? '';
		const sslPassphrase = secrets.sslPassphrase ?? (id ? await store.sslPassphrase(id) : undefined) ?? '';
		const files = sslFiles(fields);
		return {
			...(fields.ssh ? { ssh: { ...this.ssh(fields), password: sshPassword } } : {}),
			driver: fields.driver,
			host: fields.host.trim(),
			port: fields.port,
			database: fields.driver === 'sqlite' ? databaseFile(fields.database) : fields.driver === 'redis' && fields.mode === 'cluster' ? '0' : fields.database.trim(),
			...(fields.driver === 'redis' && fields.mode ? { mode: fields.mode } : {}),
			...(fields.driver === 'redis' && fields.mode === 'sentinel' && fields.master ? { master: fields.master.trim() } : {}),
			user: fields.user,
			password,
			ssl: fields.ssl,
			...files,
			...(files.sslKey && sslPassphrase ? { sslPassphrase } : {}),
		};
	}

	private html(out: vscode.Uri): string {
		const webview = this.panel.webview;
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(out, 'form.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(out, 'form-style.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
