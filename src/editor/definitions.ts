import * as vscode from 'vscode';

const SCHEME = 'columbus-ddl';

export function showSql(path: string[], content: string, language: string): Promise<void> {
	if (!Definitions.current) {
		throw new Error('SQL previews are not ready');
	}
	return Definitions.current.show(path, content, language, vscode.ViewColumn.Beside);
}

export class Definitions implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly contents = new Map<string, string>();
	private readonly changed = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changed.event;
	private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);

	static current: Definitions | undefined;

	static create(): Definitions {
		Definitions.current = new Definitions();
		return Definitions.current;
	}

	private constructor() { }

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	async show(path: string[], content: string, language = 'sql', column?: vscode.ViewColumn): Promise<void> {
		const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${path.map(part => part.replace(/\//g, '∕')).join('/')}.sql` });
		const known = this.contents.has(uri.toString());
		this.contents.set(uri.toString(), content);
		if (known) {
			this.changed.fire(uri);
		}
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.languageId !== language) {
			await vscode.languages.setTextDocumentLanguage(document, language);
		}
		await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true, ...(column ? { viewColumn: column } : {}) });
	}

	dispose(): void {
		if (Definitions.current === this) {
			Definitions.current = undefined;
		}
		this.registration.dispose();
		this.changed.dispose();
	}
}
