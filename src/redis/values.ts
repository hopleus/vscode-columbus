import type { RedisArg, RedisReply, RedisValue } from '../drivers/redis';
import type { Change, GridColumn, Value } from '../shared/protocol';

export type CollectionType = 'string' | 'json' | 'hash' | 'list' | 'set' | 'zset' | 'stream';

export interface Collection {
	type: CollectionType;
	columns: GridColumn[];
	rows: Value[][];
	total: number;
}

const column = (name: string, options: Partial<GridColumn> = {}): GridColumn => ({
	name,
	type: 'text',
	primary: false,
	foreign: false,
	numeric: false,
	nullable: false,
	generated: false,
	hasDefault: false,
	...options,
});

const binary = (hex: readonly string[], name: string): Partial<GridColumn> => (hex.includes(name) ? { type: 'binary' } : {});

export function jsonCollection(text: string): Collection {
	return { type: 'json', columns: [column('value', { type: 'json' })], rows: [[text]], total: 1 };
}

export function collection(value: RedisValue): Collection | undefined {
	switch (value.type) {
		case 'string':
			return { type: 'string', columns: [column('value', { type: value.binary ? 'binary' : 'text' })], rows: [[value.value]], total: 1 };
		case 'hash':
			return { type: 'hash', columns: [column('field', { primary: true, ...binary(value.hex, 'field') }), column('value', binary(value.hex, 'value'))], rows: value.entries, total: value.total };
		case 'list':
			return { type: 'list', columns: [column('index', { primary: true, generated: true, numeric: true, type: 'integer' }), column('value', binary(value.hex, 'value'))], rows: value.items.map((item, i) => [i, item]), total: value.total };
		case 'set':
			return { type: 'set', columns: [column('member', { primary: true, ...binary(value.hex, 'member') })], rows: value.members.map(member => [member]), total: value.total };
		case 'zset':
			return { type: 'zset', columns: [column('member', { primary: true, ...binary(value.hex, 'member') }), column('score', { numeric: true, type: 'double' })], rows: value.entries.map(([member, score]) => [member, Number(score)]), total: value.total };
		case 'stream':
			return {
				type: 'stream',
				columns: [column('id', { primary: true, generated: true }), column('fields', { generated: true, type: 'json' })],
				rows: value.entries.map(([id, fields]) => [id, JSON.stringify(Object.fromEntries(fields))]),
				total: value.total,
			};
		default:
			return undefined;
	}
}

const text = (value: Value | undefined): string => (value === null || value === undefined ? '' : String(value));

function bytes(value: string): RedisArg {
	return /^0x(?:[0-9a-f]{2})*$/i.test(value) ? Uint8Array.from(Buffer.from(value.slice(2), 'hex')) : value;
}

export function hexColumns(columns: readonly GridColumn[]): Set<string> {
	return new Set(columns.filter(c => c.type === 'binary').map(c => c.name));
}

export function commandsFor(type: CollectionType, key: RedisArg, changes: readonly Change[], rows: readonly Value[][], hex: ReadonlySet<string> = new Set()): RedisArg[][] {
	const arg = (name: string, value: Value | undefined): RedisArg => (hex.has(name) ? bytes(text(value)) : text(value));
	const commands: RedisArg[][] = [];
	const removals: string[] = [];
	const marker = `__columbus_removed_${Date.now().toString(36)}__`;
	for (const change of changes) {
		switch (type) {
			case 'string':
			case 'json':
				if (change.kind !== 'update') {
					throw new Error(`A ${type === 'json' ? 'JSON' : 'string'} key holds one value`);
				}
				commands.push(type === 'json' ? ['JSON.SET', key, '$', text(change.values.value)] : ['SET', key, arg('value', change.values.value), 'KEEPTTL']);
				break;
			case 'hash': {
				if (change.kind === 'delete') {
					commands.push(['HDEL', key, arg('field', change.key.field)]);
					break;
				}
				const field = text(change.values.field ?? (change.kind === 'update' ? change.key.field : ''));
				const old = change.kind === 'update' ? text(change.key.field) : undefined;
				const current = old === undefined ? undefined : rows.find(row => text(row[0]) === old)?.[1];
				if (old !== undefined && old !== field) {
					commands.push(['HDEL', key, arg('field', old)]);
				}
				commands.push(['HSET', key, arg('field', field), arg('value', change.values.value ?? current)]);
				break;
			}
			case 'list':
				if (change.kind === 'delete') {
					commands.push(['LSET', key, text(change.key.index), marker]);
					removals.push(marker);
				} else if (change.kind === 'update') {
					commands.push(['LSET', key, text(change.key.index), arg('value', change.values.value)]);
				} else {
					commands.push(['RPUSH', key, arg('value', change.values.value)]);
				}
				break;
			case 'set':
				if (change.kind !== 'insert') {
					commands.push(['SREM', key, arg('member', change.key.member)]);
				}
				if (change.kind !== 'delete') {
					commands.push(['SADD', key, arg('member', change.values.member ?? (change.kind === 'update' ? change.key.member : ''))]);
				}
				break;
			case 'zset': {
				if (change.kind === 'delete') {
					commands.push(['ZREM', key, arg('member', change.key.member)]);
					break;
				}
				const old = change.kind === 'update' ? text(change.key.member) : undefined;
				const member = text(change.values.member ?? old);
				const current = old === undefined ? undefined : rows.find(row => text(row[0]) === old)?.[1];
				if (old !== undefined && old !== member) {
					commands.push(['ZREM', key, arg('member', old)]);
				}
				commands.push(['ZADD', key, text(change.values.score ?? current ?? 0), arg('member', member)]);
				break;
			}
			case 'stream':
				if (change.kind !== 'delete') {
					throw new Error('Stream entries can only be deleted');
				}
				commands.push(['XDEL', key, text(change.key.id)]);
				break;
		}
	}
	if (removals.length) {
		commands.push(['LREM', key, '0', marker]);
	}
	return commands;
}

export function quoteArgument(arg: string): string {
	return /^[^\s"'\\]+$/.test(arg) ? arg : `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function commandLine(args: readonly RedisArg[]): string {
	return args.map(arg => (typeof arg === 'string' ? quoteArgument(arg) : `"${[...arg].map(b => `\\x${b.toString(16).padStart(2, '0')}`).join('')}"`)).join(' ');
}

export function parseCommand(line: string): string[] {
	const args: string[] = [];
	let i = 0;
	while (i < line.length) {
		while (i < line.length && /\s/.test(line[i])) {
			i++;
		}
		if (i >= line.length) {
			break;
		}
		const quote = line[i];
		if (quote === '"' || quote === "'") {
			let value = '';
			i++;
			while (i < line.length && line[i] !== quote) {
				if (line[i] === '\\' && quote === '"' && i + 1 < line.length) {
					const next = line[++i];
					value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
				} else if (line[i] === '\\' && quote === "'" && line[i + 1] === "'") {
					value += "'";
					i++;
				} else {
					value += line[i];
				}
				i++;
			}
			if (i >= line.length) {
				throw new Error('Unbalanced quotes');
			}
			i++;
			args.push(value);
		} else {
			let value = '';
			while (i < line.length && !/\s/.test(line[i])) {
				value += line[i++];
			}
			args.push(value);
		}
	}
	return args;
}

const PAIRED = /^(HGETALL|CONFIG|HRANDFIELD|XINFO)$/i;
const SCORED = /^(ZRANGE|ZREVRANGE|ZRANGEBYSCORE|ZREVRANGEBYSCORE|ZPOPMIN|ZPOPMAX|ZRANDMEMBER|ZUNION|ZINTER|ZDIFF)$/i;

export function replyRows(args: readonly string[], reply: RedisReply): { columns: string[]; rows: Value[][] } {
	const name = args[0] ?? '';
	const cell = (value: RedisReply): Value => (Array.isArray(value) ? JSON.stringify(value) : value);
	if (!Array.isArray(reply)) {
		return { columns: ['value'], rows: [[reply]] };
	}
	const flat = reply.every(item => !Array.isArray(item));
	const withScores = args.some(arg => /^WITHSCORES$/i.test(arg));
	if (flat && reply.length % 2 === 0 && (PAIRED.test(name) || (SCORED.test(name) && withScores) || (/^HRANDFIELD$/i.test(name) && args.some(arg => /^WITHVALUES$/i.test(arg))))) {
		const rows: Value[][] = [];
		for (let i = 0; i < reply.length; i += 2) {
			rows.push([cell(reply[i]), cell(reply[i + 1])]);
		}
		return { columns: SCORED.test(name) ? ['member', 'score'] : ['field', 'value'], rows };
	}
	if (/^(SCAN|SSCAN|HSCAN|ZSCAN)$/i.test(name) && reply.length === 2 && Array.isArray(reply[1])) {
		return { columns: ['cursor', 'value'], rows: (reply[1] as RedisReply[]).map(item => [cell(reply[0]), cell(item)]) };
	}
	return { columns: ['#', 'value'], rows: reply.map((item, i) => [i + 1, cell(item)]) };
}

export function formatTtl(ms: number): string {
	if (ms < 0) {
		return '';
	}
	const seconds = Math.ceil(ms / 1000);
	const parts: [number, string][] = [[Math.floor(seconds / 86400), 'd'], [Math.floor(seconds / 3600) % 24, 'h'], [Math.floor(seconds / 60) % 60, 'm'], [seconds % 60, 's']];
	return parts.filter(([value]) => value).slice(0, 2).map(([value, unit]) => `${value}${unit}`).join(' ') || '0s';
}
