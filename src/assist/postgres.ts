import { PostgreSQL } from 'dt-sql-parser';
import { analyze } from './engine';
import type { Analysis } from './engine';

const parser = new PostgreSQL();

export function create(): { analyze(statement: string, offset: number): Analysis } {
	return { analyze: (statement, offset) => analyze(parser, statement, offset) };
}
