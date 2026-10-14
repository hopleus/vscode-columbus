import * as vscode from 'vscode';
import type { Catalog } from '../catalog';
import type { Flavor } from '../shared/format';
import { analyzeDocument, expandStar } from './semantics';
import type { Semantics, SymbolKind } from './semantics';

export const SQL_LANGUAGES = { postgres: 'columbus-postgres', mysql: 'columbus-mysql', mariadb: 'columbus-mariadb', sqlite: 'columbus-sqlite' } as const;
export const SQL_LANGUAGE_IDS: readonly string[] = Object.values(SQL_LANGUAGES);
export const SQL_SELECTOR = SQL_LANGUAGE_IDS.map(language => ({ language }));

export function sqlLanguage(flavor: Flavor, product: string | undefined): string {
	return product === 'mariadb' ? SQL_LANGUAGES.mariadb : SQL_LANGUAGES[flavor];
}

const TYPES: Record<SymbolKind, string> = {
	schema: 'namespace',
	table: 'class',
	view: 'interface',
	column: 'property',
	alias: 'variable',
};
const LEGEND = new vscode.SemanticTokensLegend(['namespace', 'class', 'interface', 'property', 'variable'], ['declaration']);
const DELAY = 250;

export interface LanguageContext {
	catalog: Catalog;
	flavor: Flavor;
}

export class ConsoleLanguage implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('columbus');
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly cache = new Map<string, { version: number; stamp: number; semantics: Semantics }>();
	private readonly disposables: vscode.Disposable[];
	private stamp = 0;

	constructor(private readonly context: (document: vscode.TextDocument) => LanguageContext | undefined) {
		this.disposables = [
			this.changed,
			this.diagnostics,
			vscode.languages.registerDocumentSemanticTokensProvider(SQL_SELECTOR, {
				onDidChangeSemanticTokens: this.changed.event,
				provideDocumentSemanticTokens: document => this.tokens(document),
			}, LEGEND),
			vscode.languages.registerCodeActionsProvider(SQL_SELECTOR, {
				provideCodeActions: (document, range) => this.actions(document, range),
			}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] }),
			vscode.workspace.onDidChangeTextDocument(event => this.schedule(event.document)),
			vscode.workspace.onDidOpenTextDocument(document => this.schedule(document)),
			vscode.workspace.onDidCloseTextDocument(document => {
				this.diagnostics.delete(document.uri);
				this.cache.delete(document.uri.toString());
			}),
		];
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	refresh(): void {
		this.stamp++;
		this.changed.fire();
		for (const document of vscode.workspace.textDocuments) {
			this.schedule(document, 0);
		}
	}

	private analyze(document: vscode.TextDocument): { semantics: Semantics; context: LanguageContext } | undefined {
		const context = SQL_LANGUAGE_IDS.includes(document.languageId) ? this.context(document) : undefined;
		if (!context) {
			return undefined;
		}
		const key = document.uri.toString();
		const cached = this.cache.get(key);
		if (cached && cached.version === document.version && cached.stamp === this.stamp) {
			return { semantics: cached.semantics, context };
		}
		const semantics = analyzeDocument(context.catalog, document.getText(), context.flavor);
		this.cache.set(key, { version: document.version, stamp: this.stamp, semantics });
		return { semantics, context };
	}

	private schedule(document: vscode.TextDocument, delay = DELAY): void {
		if (!SQL_LANGUAGE_IDS.includes(document.languageId)) {
			return;
		}
		const key = document.uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			const found = this.analyze(document);
			this.diagnostics.set(document.uri, (found?.semantics.problems ?? []).map(problem => {
				const range = new vscode.Range(document.positionAt(problem.start), document.positionAt(problem.start + problem.length));
				const diagnostic = new vscode.Diagnostic(range, problem.message, vscode.DiagnosticSeverity.Warning);
				diagnostic.source = 'Columbus';
				return diagnostic;
			}));
		}, delay));
	}

	private tokens(document: vscode.TextDocument): vscode.SemanticTokens {
		const builder = new vscode.SemanticTokensBuilder(LEGEND);
		for (const symbol of this.analyze(document)?.semantics.symbols ?? []) {
			const start = document.positionAt(symbol.start);
			const end = document.positionAt(symbol.start + symbol.length);
			if (start.line === end.line) {
				builder.push(new vscode.Range(start, end), TYPES[symbol.kind], symbol.declaration ? ['declaration'] : []);
			}
		}
		return builder.build();
	}

	private actions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
		const found = this.analyze(document);
		if (!found) {
			return [];
		}
		const actions: vscode.CodeAction[] = [];
		const start = document.offsetAt(range.start);
		const end = document.offsetAt(range.end);
		for (const problem of found.semantics.problems) {
			if (problem.start > end || problem.start + problem.length < start) {
				continue;
			}
			const target = new vscode.Range(document.positionAt(problem.start), document.positionAt(problem.start + problem.length));
			for (const suggestion of problem.suggestions) {
				const action = new vscode.CodeAction(`Change to '${suggestion}'`, vscode.CodeActionKind.QuickFix);
				action.edit = new vscode.WorkspaceEdit();
				action.edit.replace(document.uri, target, suggestion);
				action.isPreferred = problem.suggestions.length === 1;
				actions.push(action);
			}
		}
		const star = expandStar(found.context.catalog, document.getText(), start, found.context.flavor);
		if (star) {
			const action = new vscode.CodeAction('Expand column list', vscode.CodeActionKind.RefactorRewrite);
			action.edit = new vscode.WorkspaceEdit();
			action.edit.replace(document.uri, new vscode.Range(document.positionAt(star.start), document.positionAt(star.start + star.length)), star.text);
			actions.push(action);
		}
		return actions;
	}
}
