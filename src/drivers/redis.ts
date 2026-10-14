import Valkey, { Cluster } from 'iovalkey';
import type { RedisOptions } from 'iovalkey';
import type { ConnectionOptions } from 'node:tls';
import type { ConnectionConfig } from './connection';
import { identityOptions, secureOptions } from './tls';

export interface RedisKey {
	name: string;
	bytes?: Uint8Array;
	type: string;
	ttl: number;
}

export interface RedisDatabase {
	index: number;
	keys: number;
}

export type RedisArg = string | Uint8Array;

export type RedisValue =
	| { type: 'string'; value: string; binary: boolean; ttl: number }
	| { type: 'hash'; entries: [string, string][]; hex: ('field' | 'value')[]; total: number; ttl: number }
	| { type: 'list'; items: string[]; hex: 'value'[]; total: number; ttl: number }
	| { type: 'set'; members: string[]; hex: 'member'[]; total: number; ttl: number }
	| { type: 'zset'; entries: [string, string][]; hex: 'member'[]; total: number; ttl: number }
	| { type: 'stream'; entries: [string, [string, string][]][]; total: number; ttl: number }
	| { type: 'none' }
	| { type: 'other'; name: string; ttl: number };

export type RedisReply = null | string | number | RedisReply[];

export interface RedisArgument {
	name: string;
	type: string;
	optional: boolean;
	multiple: boolean;
	token?: string;
	arguments?: RedisArgument[];
}

export interface RedisCommandDoc {
	name: string;
	summary: string;
	group: string;
	since: string;
	arguments: RedisArgument[];
}

const SCAN_COUNT = 1000;

function utf8(buffer: Buffer): string | undefined {
	const text = buffer.toString('utf8');
	return Buffer.from(text, 'utf8').equals(buffer) ? text : undefined;
}

const hex = (buffer: Buffer): string => `0x${buffer.toString('hex')}`;

const argument = (arg: RedisArg): string | Buffer => (typeof arg === 'string' ? arg : Buffer.from(arg));

function shown(buffers: readonly Buffer[]): { texts: string[]; binary: boolean } {
	const texts = buffers.map(utf8);
	const binary = texts.some(text => text === undefined);
	return { texts: binary ? buffers.map(hex) : texts as string[], binary };
}

function plain(value: unknown): RedisReply {
	if (value === null || value === undefined) {
		return null;
	}
	if (Buffer.isBuffer(value)) {
		return utf8(value) ?? hex(value);
	}
	if (Array.isArray(value)) {
		return value.map(plain);
	}
	if (typeof value === 'number' || typeof value === 'string') {
		return value;
	}
	return String(value);
}

function pairs(flat: string[]): [string, string][] {
	const result: [string, string][] = [];
	for (let i = 0; i + 1 < flat.length; i += 2) {
		result.push([flat[i], flat[i + 1]]);
	}
	return result;
}

function info(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const index = line.indexOf(':');
		if (index > 0 && !line.startsWith('#')) {
			values.set(line.slice(0, index), line.slice(index + 1).trim());
		}
	}
	return values;
}

function argumentsOf(raw: unknown): RedisArgument[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(item => {
		const fields = new Map<string, unknown>();
		const list = Array.isArray(item) ? item : [];
		for (let i = 0; i + 1 < list.length; i += 2) {
			fields.set(String(list[i]), list[i + 1]);
		}
		const flags = Array.isArray(fields.get('flags')) ? (fields.get('flags') as unknown[]).map(String) : [];
		const nested = argumentsOf(fields.get('arguments'));
		return {
			name: String(fields.get('name') ?? ''),
			type: String(fields.get('type') ?? ''),
			optional: flags.includes('optional'),
			multiple: flags.includes('multiple'),
			...(fields.has('token') ? { token: String(fields.get('token')) } : {}),
			...(nested.length ? { arguments: nested } : {}),
		};
	});
}

type Client = Valkey | Cluster;
type Address = { host: string; port: number };

const NOT_FORWARDED_YET: Address = { host: '127.0.0.1', port: 0 };

function reason(err: Error): Error {
	const cause = (err as Error & { lastNodeError?: Error }).lastNodeError;
	return cause && cause.message !== err.message ? new Error(`${err.message}: ${cause.message}`) : err;
}

export interface TunnelOptions {
	forward?(host: string, port: number): Promise<Address>;
}

export class RedisDriver {
	private readonly clients = new Map<number, Valkey>();
	private cluster: Cluster | undefined;
	private readonly sessions = new Map<string, { client: Valkey; db: number }>();
	private readonly transactions = new Map<string, { pinned?: Valkey; queue?: string[][]; multi: boolean; watching: boolean }>();
	private readonly defaultDb: number;

	private readonly opened = new WeakSet<Client>();
	private tls: ConnectionOptions | null | undefined;
	private readonly mapped = new Map<string, Address>();
	private seed: Address | undefined;
	private prepared: Promise<void> | undefined;

	constructor(private readonly config: ConnectionConfig, private readonly tunnel: TunnelOptions = {}) {
		this.defaultDb = Number.parseInt(config.database, 10) || 0;
	}

	private prepare(): Promise<void> {
		if (!this.config.mode) {
			return Promise.resolve();
		}
		this.prepared ??= this.discover();
		this.prepared.catch(() => {
			this.prepared = undefined;
		});
		return this.prepared;
	}

	private async discover(): Promise<void> {
		const tunneled = !!this.tunnel.forward;
		const seed = tunneled ? await this.tunnel.forward!(this.config.host, this.config.port) : { host: this.config.host, port: this.config.port };
		const probe = await this.ready(new Valkey({ ...this.options(), host: seed.host, port: seed.port }).on('error', () => undefined));
		try {
			const nodes: string[] = [];
			if (this.config.mode === 'cluster') {
				const ranges = await probe.call('CLUSTER', 'SLOTS').catch((err: Error) => {
					throw /cluster support disabled|cluster is disabled|unknown command/i.test(err.message) ? new Error(`${this.config.host}:${this.config.port} is not a cluster node`) : err;
				}) as unknown[][];
				nodes.push(...ranges.flatMap(range => (range.slice(2) as unknown[][]).map(node => `${String(node[0])}:${Number(node[1])}`)));
			} else {
				const reply = await probe.call('SENTINEL', 'get-master-addr-by-name', this.config.master ?? '').catch((err: Error) => {
					throw /unknown command/i.test(err.message) ? new Error(`${this.config.host}:${this.config.port} is not a Sentinel`) : err;
				});
				const [host, port] = (reply as [string, string] | null) ?? [];
				if (!host) {
					throw new Error(`Sentinel does not know the master ${this.config.master ?? ''}`);
				}
				nodes.push(`${host}:${port}`);
				for (const replica of await probe.call('SENTINEL', 'replicas', this.config.master ?? '') as string[][]) {
					const field = (name: string): string => replica[replica.indexOf(name) + 1];
					nodes.push(`${field('ip')}:${field('port')}`);
				}
			}
			if (tunneled) {
				for (const node of nodes) {
					await this.map(node);
				}
			}
			this.seed = seed;
		} finally {
			probe.disconnect();
		}
	}

	private async map(key: string): Promise<void> {
		if (!this.mapped.has(key)) {
			const separator = key.lastIndexOf(':');
			this.mapped.set(key, await this.tunnel.forward!(key.slice(0, separator), Number(key.slice(separator + 1))));
		}
	}

	private readonly natMap = (key: string): Address => {
		const separator = key.lastIndexOf(':');
		const host = key.slice(0, separator);
		let address: Address = { host, port: Number(key.slice(separator + 1)) };
		if (this.tunnel.forward) {
			const found = this.mapped.get(key);
			if (!found) {
				void this.map(key).catch(() => undefined);
				return NOT_FORWARDED_YET;
			}
			address = found;
		}
		const secure = this.secure();
		if (!secure) {
			return address;
		}
		return this.config.mode === 'cluster' ? { ...address, tls: { ...secure, ...this.identity(host) } } as Address : { ...address, ...this.identity(host) };
	};

	async version(): Promise<string> {
		await this.prepare();
		const values = info(await (await this.client(this.defaultDb)).info('server'));
		const dragonfly = values.get('dragonfly_version');
		if (dragonfly) {
			return `Dragonfly ${dragonfly.replace(/^df-v?/, '')}`;
		}
		const valkey = values.get('valkey_version') ?? (values.get('server_name') === 'valkey' ? values.get('redis_version') : undefined);
		return valkey ? `Valkey ${valkey}` : `Redis ${values.get('redis_version') ?? ''}`.trim();
	}

	async databases(): Promise<RedisDatabase[]> {
		await this.prepare();
		if (this.config.mode === 'cluster') {
			const sizes = await Promise.all((await this.masters()).map(node => node.dbsize()));
			return [{ index: 0, keys: sizes.reduce((sum, size) => sum + size, 0) }];
		}
		const client = await this.client(this.defaultDb) as Valkey;
		let count = 16;
		try {
			const reply = await client.config('GET', 'databases') as string[];
			count = Number.parseInt(reply[1], 10) || count;
		} catch {
			count = 16;
		}
		const keyspace = info(await client.info('keyspace'));
		return Array.from({ length: count }, (_, index) => ({
			index,
			keys: Number(/keys=(\d+)/.exec(keyspace.get(`db${index}`) ?? '')?.[1] ?? 0),
		}));
	}

	async scan(db: number, pattern: string, limit: number): Promise<{ keys: RedisKey[]; complete: boolean }> {
		await this.prepare();
		const nodes = this.config.mode === 'cluster' ? await this.masters() : [await this.client(db) as Valkey];
		const keys: RedisKey[] = [];
		let complete = true;
		for (const node of nodes) {
			if (keys.length >= limit) {
				complete = false;
				break;
			}
			const names = new Map<string, Buffer>();
			let cursor = '0';
			do {
				const [next, batch] = await node.scanBuffer(cursor, 'MATCH', pattern || '*', 'COUNT', SCAN_COUNT);
				cursor = String(next);
				for (const name of batch) {
					names.set(name.toString('hex'), name);
				}
			} while (cursor !== '0' && keys.length + names.size < limit);
			complete &&= cursor === '0' && keys.length + names.size <= limit;
			keys.push(...await this.describe(node, [...names.values()].slice(0, limit - keys.length)));
		}
		keys.sort((a, b) => a.name.localeCompare(b.name));
		return { keys, complete };
	}

	private async describe(node: Valkey, names: readonly Buffer[]): Promise<RedisKey[]> {
		const pipeline = node.pipeline();
		for (const name of names) {
			pipeline.type(name);
			pipeline.pttl(name);
		}
		const replies = (await pipeline.exec()) ?? [];
		return names.map((name, i) => {
			const text = utf8(name);
			return {
				name: text ?? hex(name),
				...(text === undefined ? { bytes: Uint8Array.from(name) } : {}),
				type: String(replies[i * 2]?.[1] ?? 'none'),
				ttl: Number(replies[i * 2 + 1]?.[1] ?? -1),
			};
		}).filter(key => key.type !== 'none');
	}

	private async masters(): Promise<Valkey[]> {
		const cluster = await this.client(0) as Cluster;
		const nodes = cluster.nodes('master');
		if (!nodes.length) {
			throw new Error('The cluster has no reachable master nodes');
		}
		return nodes;
	}

	async value(db: number, key: RedisArg, limit: number): Promise<RedisValue> {
		await this.prepare();
		const client = await this.client(db);
		const name = argument(key);
		const type = await client.type(name);
		const ttl = await client.pttl(name);
		switch (type) {
			case 'none':
				return { type: 'none' };
			case 'string': {
				const buffer = await client.getBuffer(name);
				const text = buffer && utf8(buffer);
				return { type: 'string', value: text ?? (buffer ? hex(buffer) : ''), binary: !!buffer && text === undefined, ttl };
			}
			case 'hash': {
				const total = await client.hlen(name);
				const flat = total <= limit ? await client.callBuffer('HGETALL', name) as Buffer[] : await this.scanAll(cursor => client.hscanBuffer(name, cursor, 'COUNT', SCAN_COUNT), limit * 2);
				const fields = shown(flat.filter((_, i) => i % 2 === 0));
				const values = shown(flat.filter((_, i) => i % 2 === 1));
				return {
					type: 'hash',
					entries: fields.texts.map((field, i) => [field, values.texts[i]]),
					hex: [...(fields.binary ? ['field' as const] : []), ...(values.binary ? ['value' as const] : [])],
					total,
					ttl,
				};
			}
			case 'list': {
				const items = shown(await client.lrangeBuffer(name, 0, limit - 1));
				return { type: 'list', items: items.texts, hex: items.binary ? ['value'] : [], total: await client.llen(name), ttl };
			}
			case 'set': {
				const total = await client.scard(name);
				const members = shown(total <= limit ? await client.smembersBuffer(name) : await this.scanAll(cursor => client.sscanBuffer(name, cursor, 'COUNT', SCAN_COUNT), limit));
				return { type: 'set', members: members.texts.sort(), hex: members.binary ? ['member'] : [], total, ttl };
			}
			case 'zset': {
				const flat = await client.zrangeBuffer(name, 0, limit - 1, 'WITHSCORES');
				const members = shown(flat.filter((_, i) => i % 2 === 0));
				const scores = flat.filter((_, i) => i % 2 === 1).map(String);
				return { type: 'zset', entries: members.texts.map((member, i) => [member, scores[i]]), hex: members.binary ? ['member'] : [], total: await client.zcard(name), ttl };
			}
			case 'stream': {
				const raw = plain(await client.callBuffer('XRANGE', name, '-', '+', 'COUNT', String(limit))) as [string, string[]][];
				return { type: 'stream', entries: raw.map(([id, fields]) => [id, pairs(fields)]), total: await client.xlen(name), ttl };
			}
			default:
				return { type: 'other', name: type, ttl };
		}
	}

	private async scanAll(page: (cursor: string) => Promise<[Buffer, Buffer[]]>, limit: number): Promise<Buffer[]> {
		const items: Buffer[] = [];
		let cursor = '0';
		do {
			const [next, batch] = await page(cursor);
			cursor = String(next);
			items.push(...batch);
		} while (cursor !== '0' && items.length < limit);
		return items.slice(0, limit);
	}

	async setString(db: number, key: RedisArg, value: string): Promise<void> {
		await this.prepare();
		const client = await this.client(db);
		const name = argument(key);
		try {
			await client.set(name, value, 'KEEPTTL');
		} catch {
			const ttl = await client.pttl(name);
			await (ttl > 0 ? client.set(name, value, 'PX', ttl) : client.set(name, value));
		}
	}

	async batch(db: number, commands: RedisArg[][]): Promise<RedisReply[]> {
		await this.prepare();
		if (!commands.length) {
			return [];
		}
		const multi = (await this.client(db)).multi();
		for (const [name, ...args] of commands) {
			multi.call(String(name).toLowerCase(), ...args.map(argument));
		}
		const replies = (await multi.exec()) ?? [];
		const failed = replies.find(([err]) => err);
		if (failed?.[0]) {
			throw failed[0];
		}
		return replies.map(([, value]) => plain(value));
	}

	async command(db: number, args: RedisArg[]): Promise<RedisReply> {
		await this.prepare();
		const [name, ...rest] = args;
		return plain(await (await this.client(db)).callBuffer(String(name), ...rest.map(argument)));
	}

	async execute(session: string, db: number, args: string[]): Promise<{ reply: RedisReply; db: number }> {
		await this.prepare();
		if (this.config.mode === 'cluster') {
			return { reply: await this.clusterExecute(session, args), db: 0 };
		}
		let entry = this.sessions.get(session);
		if (!entry || entry.client.status === 'end') {
			entry = { client: this.create(entry?.db ?? db), db: entry?.db ?? db };
			this.sessions.set(session, entry);
		}
		await this.ready(entry.client);
		const [name, ...rest] = args;
		const reply = plain(await entry.client.callBuffer(name, ...rest));
		if (/^select$/i.test(name) && reply === 'OK') {
			entry.db = Number.parseInt(rest[0], 10) || 0;
		}
		return { reply, db: entry.db };
	}

	async commands(): Promise<RedisCommandDoc[]> {
		await this.prepare();
		const client = await this.client(this.defaultDb);
		try {
			const raw = await client.call('COMMAND', 'DOCS') as unknown[];
			const docs: RedisCommandDoc[] = [];
			for (let i = 0; i + 1 < raw.length; i += 2) {
				const fields = new Map<string, unknown>();
				const list = Array.isArray(raw[i + 1]) ? raw[i + 1] as unknown[] : [];
				for (let j = 0; j + 1 < list.length; j += 2) {
					fields.set(String(list[j]), list[j + 1]);
				}
				docs.push(this.doc(String(raw[i]), fields));
				const subcommands = Array.isArray(fields.get('subcommands')) ? fields.get('subcommands') as unknown[] : [];
				for (let j = 0; j + 1 < subcommands.length; j += 2) {
					const sub = new Map<string, unknown>();
					const list = Array.isArray(subcommands[j + 1]) ? subcommands[j + 1] as unknown[] : [];
					for (let k = 0; k + 1 < list.length; k += 2) {
						sub.set(String(list[k]), list[k + 1]);
					}
					docs.push(this.doc(String(subcommands[j]).replace('|', ' '), sub));
				}
			}
			return docs.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			const raw = await client.call('COMMAND') as unknown[][];
			return raw.map(entry => ({ name: String(entry[0]).toUpperCase(), summary: '', group: '', since: '', arguments: [] })).sort((a, b) => a.name.localeCompare(b.name));
		}
	}

	private doc(name: string, fields: Map<string, unknown>): RedisCommandDoc {
		return {
			name: name.toUpperCase(),
			summary: String(fields.get('summary') ?? ''),
			group: String(fields.get('group') ?? ''),
			since: String(fields.get('since') ?? ''),
			arguments: argumentsOf(fields.get('arguments')),
		};
	}

	async cancel(session: string): Promise<boolean> {
		await this.prepare();
		const entry = this.sessions.get(session);
		if (!entry || this.config.mode === 'cluster') {
			return false;
		}
		const id = await entry.client.client('ID');
		return Number(await (await this.client(this.defaultDb) as Valkey).client('UNBLOCK', id, 'ERROR')) === 1;
	}

	private async clusterExecute(session: string, args: string[]): Promise<RedisReply> {
		const cluster = await this.client(0) as Cluster;
		const name = args[0].toUpperCase();
		const state = this.transactions.get(session) ?? { multi: false, watching: false };
		this.transactions.set(session, state);
		if (!state.pinned) {
			if (name === 'MULTI') {
				if (state.queue) {
					throw new Error('ERR MULTI calls can not be nested');
				}
				state.queue = [];
				return 'OK';
			}
			if (state.queue && name === 'DISCARD') {
				state.queue = undefined;
				return 'OK';
			}
			const key = name === 'EXEC' ? undefined : await this.firstKey(cluster, args);
			if (state.queue) {
				if (key === undefined && name !== 'EXEC') {
					state.queue.push(args);
					return 'QUEUED';
				}
				state.pinned = await this.connectionFor(cluster, key);
				await state.pinned.call('MULTI');
				state.multi = true;
				for (const queued of state.queue) {
					await state.pinned.callBuffer(queued[0], ...queued.slice(1)).catch(() => undefined);
				}
				state.queue = undefined;
			} else if (name === 'WATCH' && key !== undefined) {
				state.pinned = await this.connectionFor(cluster, key);
			} else {
				return plain(await cluster.callBuffer(args[0], ...args.slice(1)));
			}
		}
		const pinned = state.pinned;
		try {
			const reply = plain(await pinned.callBuffer(args[0], ...args.slice(1)));
			if (name === 'MULTI') {
				state.multi = true;
			} else if (name === 'WATCH') {
				state.watching = true;
			} else if (name === 'UNWATCH') {
				state.watching = false;
			}
			return reply;
		} finally {
			if (name === 'EXEC' || name === 'DISCARD') {
				state.multi = false;
				state.watching = false;
			}
			if ((!state.multi && !state.watching) || pinned.status === 'end') {
				pinned.disconnect();
				this.transactions.delete(session);
			}
		}
	}

	private async firstKey(cluster: Cluster, args: string[]): Promise<string | undefined> {
		if (args.length < 2) {
			return undefined;
		}
		try {
			const keys = await cluster.call('COMMAND', 'GETKEYS', ...args) as string[];
			return keys[0];
		} catch {
			return undefined;
		}
	}

	private async connectionFor(cluster: Cluster, key: string | undefined): Promise<Valkey> {
		const masters = cluster.nodes('master');
		let owner = masters[0];
		if (key !== undefined) {
			const slot = Number(await cluster.call('CLUSTER', 'KEYSLOT', key));
			const range = (await cluster.call('CLUSTER', 'SLOTS') as unknown[][]).find(r => slot >= Number(r[0]) && slot <= Number(r[1]));
			const announced = `${String((range?.[2] as unknown[])?.[0])}:${Number((range?.[2] as unknown[])?.[1])}`;
			if (this.tunnel.forward) {
				await this.map(announced);
			}
			const separator = announced.lastIndexOf(':');
			const address = this.tunnel.forward || this.secure() ? this.natMap(announced) : { host: announced.slice(0, separator), port: Number(announced.slice(separator + 1)) };
			owner = masters.find(node => node.options.host === address.host && node.options.port === address.port) ?? owner;
		}
		if (!owner) {
			throw new Error('The cluster has no reachable master nodes');
		}
		const pinned = owner.duplicate({ lazyConnect: false });
		pinned.on('error', () => undefined);
		return this.ready(pinned);
	}

	async release(session: string): Promise<void> {
		const entry = this.sessions.get(session);
		this.sessions.delete(session);
		entry?.client.disconnect();
		this.transactions.get(session)?.pinned?.disconnect();
		this.transactions.delete(session);
	}

	disconnect(): void {
		this.dispose();
	}

	dispose(): void {
		for (const client of this.clients.values()) {
			client.disconnect();
		}
		for (const { client } of this.sessions.values()) {
			client.disconnect();
		}
		for (const { pinned } of this.transactions.values()) {
			pinned?.disconnect();
		}
		this.transactions.clear();
		this.cluster?.disconnect();
		this.cluster = undefined;
		this.clients.clear();
		this.sessions.clear();
	}

	private async client(db: number): Promise<Client> {
		if (this.config.mode === 'cluster') {
			if (this.cluster?.status === 'end') {
				this.cluster = undefined;
			}
			this.cluster ??= this.createCluster();
			return this.ready(this.cluster);
		}
		let client = this.clients.get(db);
		if (!client || client.status === 'end') {
			client = this.create(db);
			this.clients.set(db, client);
		}
		return this.ready(client);
	}

	private forget(client: Client): void {
		client.disconnect();
		if (this.cluster === client) {
			this.cluster = undefined;
		}
		for (const [db, known] of this.clients) {
			if (known === client) {
				this.clients.delete(db);
			}
		}
		for (const [session, entry] of this.sessions) {
			if (entry.client === client) {
				this.sessions.delete(session);
			}
		}
	}

	private async ready<T extends Client>(client: T): Promise<T> {
		if (client.status === 'ready') {
			return client;
		}
		await new Promise<void>((resolve, reject) => {
			let last: Error | undefined;
			const settle = (err?: Error): void => {
				client.off('ready', onReady);
				client.off('error', onError);
				client.off('end', onEnd);
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			};
			const onReady = (): void => settle();
			const onError = (err: Error): void => {
				last = err;
				if (!this.opened.has(client)) {
					settle(reason(err));
					this.forget(client);
				}
			};
			const onEnd = (): void => settle(reason(last ?? new Error('Connection is closed')));
			client.on('ready', onReady);
			client.on('error', onError);
			client.on('end', onEnd);
		});
		return client;
	}

	private secure(): ConnectionOptions | undefined {
		if (this.tls === undefined) {
			this.tls = secureOptions(this.config) ?? null;
		}
		return this.tls ?? undefined;
	}

	private identity(host: string): ConnectionOptions {
		return identityOptions(this.config, host, this.config.servername ?? this.config.host);
	}

	private options(): RedisOptions {
		const { user, password } = this.config;
		const secure = this.secure();
		return {
			username: user || undefined,
			password: password || undefined,
			connectTimeout: 10000,
			maxRetriesPerRequest: 1,
			retryStrategy: times => (times > 2 ? null : 300),
			...(secure ? { tls: { ...secure, ...this.identity(this.config.servername ?? this.config.host) } } : {}),
		};
	}

	private create(db: number): Valkey {
		const { host, port, mode, master } = this.config;
		const tunneled = !!this.tunnel.forward;
		const secure = this.secure();
		const target = mode === 'sentinel'
			? {
				sentinels: [this.seed ?? { host, port }],
				name: master,
				failoverDetector: true,
				sentinelRetryStrategy: (times: number) => (times > 2 ? null : 300),
				...(tunneled || secure ? { natMap: this.natMap } : {}),
				...(tunneled ? { updateSentinels: false } : {}),
				...(secure ? { tls: secure, enableTLSForSentinelMode: true, sentinelTLS: this.options().tls } : {}),
			}
			: { host, port };
		const client = new Valkey({ ...this.options(), ...target, db });
		client.on('error', () => undefined);
		client.once('ready', () => this.opened.add(client));
		return client;
	}

	private createCluster(): Cluster {
		const { host, port } = this.config;
		const options = this.options();
		const seed = { ...this.seed ?? { host, port }, ...(options.tls ? { tls: options.tls } : {}) };
		const cluster = new Cluster([seed], {
			redisOptions: options,
			...(this.tunnel.forward || options.tls ? { natMap: this.natMap } : {}),
			slotsRefreshTimeout: 10000,
			clusterRetryStrategy: times => (times > 2 ? null : 300),
		});
		cluster.on('error', () => undefined);
		cluster.once('ready', () => this.opened.add(cluster));
		return cluster;
	}
}

export function create(config: ConnectionConfig, tunnel?: TunnelOptions): RedisDriver {
	return new RedisDriver(config, tunnel);
}
