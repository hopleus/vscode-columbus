import * as assert from 'node:assert/strict';
import Valkey from 'iovalkey';
import type { RedisDriver } from '../drivers/redis';

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

export async function failover(sentinelPort: number, master: string): Promise<number> {
	const sentinel = new Valkey({ host: '127.0.0.1', port: sentinelPort });
	try {
		const address = async (): Promise<string[]> => await sentinel.call('SENTINEL', 'get-master-addr-by-name', master) as string[];
		const synced = async (): Promise<boolean> => (await sentinel.call('SENTINEL', 'replicas', master) as string[][])
			.some(replica => replica[replica.indexOf('flags') + 1] === 'slave' && replica[replica.indexOf('master-link-status') + 1] === 'ok');
		for (let i = 0; i < 150 && !await synced(); i++) {
			await pause(200);
		}
		const [, before] = await address();
		await sentinel.call('SENTINEL', 'failover', master);
		for (let i = 0; i < 100; i++) {
			const [, now] = await address();
			if (now !== before) {
				await pause(500);
				return Number(now);
			}
			await pause(200);
		}
		throw new Error(`Sentinel did not promote a replica of ${master}`);
	} finally {
		sentinel.disconnect();
	}
}

export async function read(port: number, key: string): Promise<{ role: string; value: string | null }> {
	const node = new Valkey({ host: '127.0.0.1', port });
	try {
		return { role: /role:(\w+)/.exec(await node.info('replication'))?.[1] ?? '', value: await node.get(key) };
	} finally {
		node.disconnect();
	}
}

type Node = { id: string; port: number; master: boolean; slots: [number, number][] };

async function nodes(port: number): Promise<Node[]> {
	const node = new Valkey({ host: '127.0.0.1', port });
	try {
		return (await node.call('CLUSTER', 'NODES') as string).trim().split('\n').map(line => {
			const [id, address, flags, , , , , , ...slots] = line.split(' ');
			return {
				id,
				port: Number(/:(\d+)@/.exec(address)?.[1]),
				master: flags.split(',').includes('master'),
				slots: slots.filter(range => !range.startsWith('[')).map(range => {
					const [from, to = from] = range.split('-').map(Number);
					return [from, to] as [number, number];
				}),
			};
		});
	} finally {
		node.disconnect();
	}
}

async function on(port: number, ...args: (string | number)[]): Promise<unknown> {
	const node = new Valkey({ host: '127.0.0.1', port });
	try {
		return await node.call(String(args[0]), ...args.slice(1).map(String));
	} finally {
		node.disconnect();
	}
}

export async function reshard(seed: number, newcomer: number, key: string): Promise<number> {
	if (!(await nodes(seed)).some(node => node.port === newcomer)) {
		await on(seed, 'CLUSTER', 'MEET', '127.0.0.1', newcomer, newcomer + 1000);
	}
	for (let i = 0; i < 100; i++) {
		const known = await Promise.all([seed, newcomer].map(nodes));
		const healthy = /cluster_state:ok/.test(String(await on(newcomer, 'CLUSTER', 'INFO')));
		if (healthy && known.every(list => list.length === known[0].length && list.some(node => node.port === newcomer) && list.some(node => node.port === seed))) {
			break;
		}
		await pause(200);
	}
	const slot = Number(await on(seed, 'CLUSTER', 'KEYSLOT', key));
	const masters = (await nodes(seed)).filter(node => node.master);
	const owner = masters.find(node => node.slots.some(([from, to]) => slot >= from && slot <= to))!;
	const target = owner.port === newcomer ? masters.find(node => node.port !== newcomer)! : masters.find(node => node.port === newcomer)!;
	await on(target.port, 'CLUSTER', 'SETSLOT', slot, 'IMPORTING', owner.id);
	await on(owner.port, 'CLUSTER', 'SETSLOT', slot, 'MIGRATING', target.id);
	const keys = await on(owner.port, 'CLUSTER', 'GETKEYSINSLOT', slot, 1000) as string[];
	if (keys.length) {
		await on(owner.port, 'MIGRATE', '127.0.0.1', target.port, '', 0, 5000, 'KEYS', ...keys);
	}
	for (const node of [target, owner, ...masters.filter(node => node !== target && node !== owner)]) {
		await on(node.port, 'CLUSTER', 'SETSLOT', slot, 'NODE', target.id);
	}
	return target.port;
}

export async function clusterTransactions(cluster: RedisDriver, other: RedisDriver): Promise<void> {
	const run = async (...args: string[]): Promise<unknown> => (await cluster.execute('tx', 0, args)).reply;
	assert.equal(await run('MULTI'), 'OK');
	assert.equal(await run('SET', '{columbus:tx}a', '1'), 'QUEUED');
	assert.equal(await run('INCR', '{columbus:tx}a'), 'QUEUED');
	assert.deepEqual(await run('EXEC'), ['OK', 2]);
	assert.equal(await run('WATCH', '{columbus:tx}a'), 'OK');
	await other.batch(0, [['SET', '{columbus:tx}a', 'changed']]);
	assert.equal(await run('MULTI'), 'OK');
	assert.equal(await run('SET', '{columbus:tx}a', 'mine'), 'QUEUED');
	assert.equal(await run('EXEC'), null);
	assert.equal(await run('GET', '{columbus:tx}a'), 'changed');
	assert.equal(await run('MULTI'), 'OK');
	assert.equal(await run('PING'), 'QUEUED');
	assert.deepEqual(await run('EXEC'), ['PONG']);
	assert.equal(await run('MULTI'), 'OK');
	assert.equal(await run('SET', '{columbus:tx}b', '1'), 'QUEUED');
	assert.equal(await run('DISCARD'), 'OK');
	assert.equal(await run('EXISTS', '{columbus:tx}b'), 0);
	await assert.rejects(cluster.execute('tx', 0, ['SELECT', '1']), /SELECT is not allowed in cluster mode/);
	await run('DEL', '{columbus:tx}a');
	await cluster.release('tx');
}
