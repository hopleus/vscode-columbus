import type { Catalog, ObjectInfo, TableRef } from '../catalog';
import type { Flavor } from '../shared/format';
import type { Change, Value } from '../shared/protocol';

export interface SelectRequest {
	table: TableRef;
	where: string;
	orderBy: string;
	offset: number;
	limit: number;
	session?: string;
}

export interface CursorRequest {
	table: TableRef;
	where: string;
	orderBy: string;
	session?: string;
}

export interface CursorPage {
	rows: Value[][];
	done: boolean;
}

export interface SelectResult {
	rows: Value[][];
	more: boolean;
	total: number | undefined;
}

export interface ColumnOrigin {
	schema: string;
	table: string;
	column: string;
}

export interface ResultColumn {
	name: string;
	type: string;
	numeric: boolean;
	origin?: ColumnOrigin;
	primary?: boolean;
	foreign?: boolean;
	references?: ColumnOrigin;
}

export type ExecuteResult =
	| { kind: 'rows'; columns: ResultColumn[]; rows: Value[][]; truncated: boolean }
	| { kind: 'count'; command: string; affected: number };

export const RESULT_ROW_LIMIT = 1000;

export interface Driver {
	readonly flavor: Flavor;
	version(): Promise<string>;
	catalog(databases?: string[]): Promise<Catalog>;
	select(request: SelectRequest): Promise<SelectResult>;
	count(table: TableRef, where: string, session?: string): Promise<number>;
	apply(table: TableRef, changes: Change[], session?: string): Promise<void>;
	preview(table: TableRef, changes: Change[]): Promise<string>;
	ddl(table: TableRef): Promise<string>;
	definition(object: ObjectInfo): Promise<string>;
	openCursor(request: CursorRequest): Promise<string>;
	fetchCursor(id: string, limit: number): Promise<CursorPage>;
	closeCursor(id: string): Promise<void>;
	execute(sql: string, session: string, database?: string): Promise<ExecuteResult[]>;
	commit(session: string): Promise<void>;
	rollback(session: string): Promise<void>;
	cancel(key: string): Promise<boolean>;
	disconnect(): void;
	dispose(): void;
}
