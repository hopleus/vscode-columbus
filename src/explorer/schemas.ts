import * as vscode from 'vscode';

const KEY = 'columbus.visibleSchemas';
const DATABASES = 'columbus.visibleDatabases';
const PATTERNS = 'columbus.keyPatterns';

export class SchemaFilter implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<string>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly state: vscode.Memento) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	visible(id: string): ReadonlySet<string> | undefined {
		const schemas = this.state.get<Record<string, string[]>>(KEY, {})[id];
		return schemas && new Set(schemas);
	}

	databases(id: string): string[] | undefined {
		return this.state.get<Record<string, string[]>>(DATABASES, {})[id];
	}

	async setDatabases(id: string, databases: readonly string[] | undefined): Promise<void> {
		const all = { ...this.state.get<Record<string, string[]>>(DATABASES, {}) };
		if (databases?.length) {
			all[id] = [...databases];
		} else {
			delete all[id];
		}
		await this.state.update(DATABASES, all);
		this._onDidChange.fire(id);
	}

	pattern(id: string, db: number): string {
		return this.state.get<Record<string, string>>(PATTERNS, {})[`${id}/${db}`] ?? '';
	}

	async setPattern(id: string, db: number, pattern: string): Promise<void> {
		const all = { ...this.state.get<Record<string, string>>(PATTERNS, {}) };
		if (pattern && pattern !== '*') {
			all[`${id}/${db}`] = pattern;
		} else {
			delete all[`${id}/${db}`];
		}
		await this.state.update(PATTERNS, all);
		this._onDidChange.fire(id);
	}

	async set(id: string, schemas: readonly string[] | undefined): Promise<void> {
		const all = { ...this.state.get<Record<string, string[]>>(KEY, {}) };
		if (schemas) {
			all[id] = [...schemas];
		} else {
			delete all[id];
		}
		await this.state.update(KEY, all);
		this._onDidChange.fire(id);
	}
}
