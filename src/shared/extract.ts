import { QUOTES, quoteIdentifier, sqlLiteral } from './format';
import type { Flavor } from './format';
import type { Value } from './protocol';

export type ExtractorId = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown';

export interface ExtractTarget {
	columns: string[];
	table: string;
	flavor: Flavor;
}

interface Extractor {
	label: string;
	extension: string;
	copyHeader: boolean;
	header(target: ExtractTarget): string;
	rows(target: ExtractTarget, rows: readonly Value[][], first: boolean): string;
	footer(target: ExtractTarget): string;
}

function delimited(separator: string): Pick<Extractor, 'header' | 'rows' | 'footer'> {
	const cell = (value: Value): string => {
		if (value === null) {
			return '';
		}
		const text = String(value);
		return /["\r\n]/.test(text) || text.includes(separator) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	return {
		header: target => `${target.columns.map(cell).join(separator)}\n`,
		rows: (_, rows) => rows.map(row => `${row.map(cell).join(separator)}\n`).join(''),
		footer: () => '',
	};
}

function markdownCell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export const EXTRACTORS: Record<ExtractorId, Extractor> = {
	csv: { label: 'CSV', extension: 'csv', copyHeader: false, ...delimited(',') },
	tsv: { label: 'TSV', extension: 'tsv', copyHeader: false, ...delimited('\t') },
	json: {
		label: 'JSON',
		extension: 'json',
		copyHeader: true,
		header: () => '[',
		rows: (target, rows, first) => rows.map((row, i) => {
			const object = Object.fromEntries(target.columns.map((column, j) => [column, row[j]]));
			return `${first && i === 0 ? '' : ','}\n  ${JSON.stringify(object)}`;
		}).join(''),
		footer: () => '\n]\n',
	},
	sql: {
		label: 'SQL Inserts',
		extension: 'sql',
		copyHeader: true,
		header: () => '',
		rows: (target, rows) => {
			const columns = target.columns.map(c => quoteIdentifier(c, QUOTES[target.flavor])).join(', ');
			return rows.map(row => `INSERT INTO ${target.table} (${columns}) VALUES (${row.map(v => sqlLiteral(v, target.flavor)).join(', ')});\n`).join('');
		},
		footer: () => '',
	},
	markdown: {
		label: 'Markdown',
		extension: 'md',
		copyHeader: true,
		header: target => `| ${target.columns.map(markdownCell).join(' | ')} |\n|${target.columns.map(() => ' --- ').join('|')}|\n`,
		rows: (_, rows) => rows.map(row => `| ${row.map(v => v === null ? '' : markdownCell(String(v))).join(' | ')} |\n`).join(''),
		footer: () => '',
	},
};

export function extract(id: ExtractorId, target: ExtractTarget, rows: readonly Value[][], header = true): string {
	const extractor = EXTRACTORS[id];
	const framed = header || extractor.copyHeader;
	return `${framed ? extractor.header(target) : ''}${extractor.rows(target, rows, true)}${framed ? extractor.footer(target) : ''}`;
}
