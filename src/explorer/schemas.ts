import * as vscode from 'vscode';

const KEY = 'columbus.visibleSchemas';
const DATABASES = 'columbus.visibleDatabases';
const PATTERNS = 'columbus.keyPatterns';

export class SchemaFilter implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<string>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly stateOf: (id: string) => vscode.Memento) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	visible(id: string): ReadonlySet<string> | undefined {
		const schemas = this.stateOf(id).get<Record<string, string[]>>(KEY, {})[id];
		return schemas && new Set(schemas);
	}

	databases(id: string): string[] | undefined {
		return this.stateOf(id).get<Record<string, string[]>>(DATABASES, {})[id];
	}

	async setDatabases(id: string, databases: readonly string[] | undefined): Promise<void> {
		const state = this.stateOf(id);
		const all = { ...state.get<Record<string, string[]>>(DATABASES, {}) };
		if (databases?.length) {
			all[id] = [...databases];
		} else {
			delete all[id];
		}
		await state.update(DATABASES, all);
		this._onDidChange.fire(id);
	}

	pattern(id: string, db: number): string {
		return this.stateOf(id).get<Record<string, string>>(PATTERNS, {})[`${id}/${db}`] ?? '';
	}

	async setPattern(id: string, db: number, pattern: string): Promise<void> {
		const state = this.stateOf(id);
		const all = { ...state.get<Record<string, string>>(PATTERNS, {}) };
		if (pattern && pattern !== '*') {
			all[`${id}/${db}`] = pattern;
		} else {
			delete all[`${id}/${db}`];
		}
		await state.update(PATTERNS, all);
		this._onDidChange.fire(id);
	}

	async forget(id: string): Promise<void> {
		const state = this.stateOf(id);
		const without = <T>(key: string, keep: (entry: string) => boolean): Thenable<void> =>
			state.update(key, Object.fromEntries(Object.entries(state.get<Record<string, T>>(key, {})).filter(([entry]) => keep(entry))));
		await without<string[]>(KEY, entry => entry !== id);
		await without<string[]>(DATABASES, entry => entry !== id);
		await without<string>(PATTERNS, entry => !entry.startsWith(`${id}/`));
		this._onDidChange.fire(id);
	}

	async move(id: string, from: vscode.Memento, to: vscode.Memento): Promise<void> {
		for (const [key, owned] of [[KEY, (entry: string) => entry === id], [DATABASES, (entry: string) => entry === id], [PATTERNS, (entry: string) => entry.startsWith(`${id}/`)]] as const) {
			const source = from.get<Record<string, unknown>>(key, {});
			const moved = Object.entries(source).filter(([entry]) => owned(entry));
			if (!moved.length) {
				continue;
			}
			await to.update(key, { ...to.get<Record<string, unknown>>(key, {}), ...Object.fromEntries(moved) });
			await from.update(key, Object.fromEntries(Object.entries(source).filter(([entry]) => !owned(entry))));
		}
		this._onDidChange.fire(id);
	}

	async set(id: string, schemas: readonly string[] | undefined): Promise<void> {
		const state = this.stateOf(id);
		const all = { ...state.get<Record<string, string[]>>(KEY, {}) };
		if (schemas) {
			all[id] = [...schemas];
		} else {
			delete all[id];
		}
		await state.update(KEY, all);
		this._onDidChange.fire(id);
	}
}
