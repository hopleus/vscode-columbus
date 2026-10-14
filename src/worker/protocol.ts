import type { ObjectInfo, TableRef } from '../catalog';
import type { ConnectionConfig } from '../drivers/connection';
import type { CursorRequest, SelectRequest } from '../drivers/driver';
import type { Change } from '../shared/protocol';

export interface WorkerData {
	module: string;
	config: ConnectionConfig;
	tunnel?: string;
}

export type WorkerCall =
	| { method: 'version' }
	| { method: 'catalog'; params?: { databases?: string[] } }
	| { method: 'select'; params: SelectRequest }
	| { method: 'count'; params: { table: TableRef; where: string; session?: string } }
	| { method: 'apply'; params: { table: TableRef; changes: Change[]; session?: string } }
	| { method: 'preview'; params: { table: TableRef; changes: Change[] } }
	| { method: 'ddl'; params: { table: TableRef } }
	| { method: 'definition'; params: { object: ObjectInfo } }
	| { method: 'openCursor'; params: CursorRequest }
	| { method: 'fetchCursor'; params: { id: string; limit: number } }
	| { method: 'closeCursor'; params: { id: string } }
	| { method: 'execute'; params: { sql: string; session: string; database?: string } }
	| { method: 'cancel'; params: { key: string } }
	| { method: 'commit'; params: { session: string } }
	| { method: 'rollback'; params: { session: string } }
	| { method: 'invoke'; params: { name: string; args: unknown[] } };

export type WorkerRequest = WorkerCall & { id: number };

export interface WorkerResponse {
	id: number;
	result?: unknown;
	error?: string;
}
