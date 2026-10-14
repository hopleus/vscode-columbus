import type { ExecuteResult } from '../drivers/driver';
import type { Flavor } from './format';
import type { HostMessage, ViewMessage } from './protocol';

export const OUTPUT_TAB = 0;

export type ResultState =
	| { type: 'running'; source: string; sql: string }
	| { type: 'results'; source: string; sql: string; elapsed: number; results: ExecuteResult[]; flavor: Flavor; more: boolean }
	| { type: 'error'; source: string; sql: string; elapsed: number; message: string };

export interface OutputEntry {
	time: string;
	source: string;
	sql: string;
	text: string;
	failed: boolean;
}

export interface ResultTabInfo {
	id: number;
	title: string;
	pinned: boolean;
	state: ResultState['type'];
}

export type ResultsMessage = {
	type: 'state';
	tabs: ResultTabInfo[];
	active: number | undefined;
	version: number;
	content: ResultState | undefined;
	output: OutputEntry[];
};

export type ResultsHostMessage = ResultsMessage | Exclude<HostMessage, { type: 'init' }>;

export type ResultsViewMessage =
	| { type: 'ready' }
	| { type: 'cancel' }
	| { type: 'select'; id: number }
	| { type: 'close'; id: number }
	| { type: 'pin'; id: number }
	| { type: 'grid'; tab: number; message: ViewMessage };

export function summary(result: ExecuteResult, more = false): string {
	if (result.kind === 'rows') {
		const count = result.rows.length;
		return `${count}${more || result.truncated ? '+' : ''} row${count === 1 && !more ? '' : 's'} retrieved`;
	}
	return `${result.command} ${result.affected} row${result.affected === 1 ? '' : 's'}`.trim();
}
