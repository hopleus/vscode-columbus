import type { BasicSQL } from 'dt-sql-parser/dist/parser/common/basicSQL';

export interface AnalysisTable {
	name: string[];
	alias?: string;
	columns?: string[];
}

export interface Analysis {
	contexts: { type: string; words: string[] }[];
	keywords: string[];
	tables: AnalysisTable[];
}

interface Entity {
	entityContextType: string;
	text: string;
	isAccessible: boolean | null;
	declareType?: number;
	position: { startIndex: number };
	columns?: { text: string; declareType?: number; _alias?: { text: string } | null }[];
	relatedEntities?: Entity[] | null;
	_alias?: { text: string } | null;
}

const NAME = /"(?:[^"]|"")+"|`(?:[^`]|``)+`|[^.\s]+/g;

function unquote(name: string): string {
	const quote = name[0];
	return (quote === '"' || quote === '`') && name.endsWith(quote) ? name.slice(1, -1).split(quote + quote).join(quote) : name;
}

function columnsOf(entity: Entity | undefined): string[] | undefined {
	return entity?.columns?.filter(c => c.declareType !== 1 && c.declareType !== 2 && !c.text.endsWith('.')).map(c => unquote(c._alias?.text ?? c.text.split('.').pop() ?? c.text));
}

function cteColumns(statement: string, name: string, entities: readonly Entity[]): string[] | undefined {
	const match = new RegExp(`(?:\\bWITH\\b(?:\\s+RECURSIVE)?|,)\\s*["\`]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["\`]?\\s*(?:\\([^)]*\\))?\\s+AS\\s*\\(`, 'i').exec(statement);
	if (!match) {
		return undefined;
	}
	const start = match.index + match[0].length;
	return columnsOf(entities.find(e => e.entityContextType === 'queryResult' && e.position.startIndex >= start));
}

export function analyze(parser: BasicSQL, statement: string, offset: number): Analysis {
	const lines = statement.slice(0, offset).split('\n');
	const caret = { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
	const suggestions = parser.getSuggestionAtCaretPosition(statement, caret);
	let entities: Entity[] = [];
	try {
		entities = (parser.getAllEntities(statement, caret) ?? []) as unknown as Entity[];
	} catch {
		entities = [];
	}
	const tables: AnalysisTable[] = entities
		.filter(e => (e.entityContextType === 'table' || e.entityContextType === 'view') && e.isAccessible)
		.map(e => {
			const alias = e._alias?.text ? unquote(e._alias.text) : undefined;
			if (e.declareType === 1) {
				return { name: [], alias, columns: columnsOf(e.relatedEntities?.find(r => r.entityContextType === 'queryResult')) };
			}
			const name = (e.text.match(NAME) ?? []).map(unquote);
			return { name, alias, columns: name.length === 1 ? cteColumns(statement, name[0], entities) : undefined };
		});
	return {
		contexts: (suggestions?.syntax ?? []).map(s => ({ type: String(s.syntaxContextType), words: s.wordRanges.map(w => w.text) })),
		keywords: suggestions?.keywords ?? [],
		tables,
	};
}
