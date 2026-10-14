import type { TableRef } from '../catalog';
import type { ExtractorId } from './extract';
import type { Flavor } from './format';

export type Value = string | number | boolean | null;

export type PanelRestore =
	| { kind: 'table'; source: string; ref: TableRef; where: string }
	| { kind: 'redisKey'; source: string; db: number; key: string; bytes?: string };

export type Row = Record<string, Value>;

export interface GridColumn {
	name: string;
	type: string;
	primary: boolean;
	foreign: boolean;
	numeric: boolean;
	nullable: boolean;
	generated: boolean;
	hasDefault: boolean;
	references?: { schema: string; table: string; column: string };
}

export type Change =
	| { kind: 'update'; key: Row; values: Row; expressions?: Record<string, string> }
	| { kind: 'insert'; values: Row; expressions?: Record<string, string> }
	| { kind: 'delete'; key: Row };

export interface ViewOptions {
	editable: boolean;
	transactions: boolean;
	ddl: boolean;
	filters: boolean;
	sql?: boolean;
	openInTab?: boolean;
	expressions?: boolean;
}

export type HostMessage =
	| { type: 'init'; columns: GridColumn[]; pageSize: number; readOnly: boolean; flavor: Flavor; table: string; where: string; panel: string; options?: ViewOptions; sql?: string; badge?: string; restore?: PanelRestore }
	| { type: 'rows'; requestId: number; offset: number; rows: Value[][]; more: boolean; total: number | undefined }
	| { type: 'counted'; requestId: number; total: number }
	| { type: 'submitted'; requestId: number; transaction: boolean }
	| { type: 'transaction'; requestId: number; manual: boolean; active: boolean }
	| { type: 'done'; requestId: number }
	| { type: 'text'; requestId: number; text: string }
	| { type: 'confirmed'; requestId: number; ok: boolean }
	| { type: 'failed'; requestId: number; message: string };

export type ViewMessage =
	| { type: 'ready' }
	| { type: 'load'; requestId: number; where: string; orderBy: string; offset: number; limit: number }
	| { type: 'count'; requestId: number; where: string }
	| { type: 'openInTab'; requestId: number }
	| { type: 'query'; requestId: number; action: 'locate' | 'console' }
	| { type: 'badge'; requestId: number }
	| { type: 'submit'; requestId: number; changes: Change[] }
	| { type: 'preview'; requestId: number; changes: Change[] }
	| { type: 'ddl'; requestId: number }
	| { type: 'export'; requestId: number; format: ExtractorId; where: string; orderBy: string; clipboard: boolean }
	| { type: 'clipboard'; requestId: number; text: string }
	| { type: 'readClipboard'; requestId: number }
	| { type: 'navigate'; requestId: number; schema: string; table: string; where: string }
	| { type: 'mode'; requestId: number; manual: boolean }
	| { type: 'cancel'; requestId: number }
	| { type: 'commit'; requestId: number }
	| { type: 'rollback'; requestId: number }
	| { type: 'confirm'; requestId: number; message: string; action: string };

export type HostPush = { type: 'filter'; where: string } | { type: 'menu'; action: string } | { type: 'disconnected' } | { type: 'badge'; text: string };
