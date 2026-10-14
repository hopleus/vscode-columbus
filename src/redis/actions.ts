import * as vscode from 'vscode';
import type { Node } from '../explorer/tree';
import type { SchemaFilter } from '../explorer/schemas';
import type { RedisSource, Sources } from '../sources';
import { nameArg, openKey, openKeyAsText } from './keys';
import type { KeyTarget } from './keys';
import type { RedisConsoles } from './console';

type KeyNode = Extract<Node, { kind: 'redisKey' }>;
type DbNode = Extract<Node, { kind: 'redisDb' }>;
type FolderNode = Extract<Node, { kind: 'redisFolder' }>;

const keyTarget = (node: KeyNode): KeyTarget => ({ source: node.source, db: node.db, key: node.key.name, ...(node.key.bytes ? { bytes: node.key.bytes } : {}) });

const INITIAL: Record<string, (key: string) => string[]> = {
	string: key => ['SET', key, ''],
	hash: key => ['HSET', key, 'field', 'value'],
	list: key => ['RPUSH', key, 'value'],
	set: key => ['SADD', key, 'member'],
	zset: key => ['ZADD', key, '0', 'member'],
	stream: key => ['XADD', key, '*', 'field', 'value'],
};

export function registerRedisActions(extensionUri: vscode.Uri, sources: Sources, filter: SchemaFilter, consoles: RedisConsoles): vscode.Disposable[] {
	const guarded = (id: string, run: (node: Node) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, async (node?: Node) => {
		if (!node) {
			return;
		}
		try {
			await run(node);
		} catch (err) {
			void vscode.window.showErrorMessage(`Columbus: ${(err as Error).message}`);
		}
	});
	const refresh = (source: RedisSource): void => sources.refresh(source.id);
	return [
		guarded('columbus.redis.openKey', node => node.kind === 'redisKey' && openKey(extensionUri, keyTarget(node), node.key.type, () => refresh(node.source))),
		guarded('columbus.redis.openAsText', node => node.kind === 'redisKey' && openKeyAsText(keyTarget(node), node.key.type)),
		guarded('columbus.redis.openConsole', node => node.kind === 'redisDb' && consoles.open(node.source, node.db)),
		guarded('columbus.redis.filterKeys', async node => {
			if (node.kind !== 'redisDb') {
				return;
			}
			const pattern = await vscode.window.showInputBox({
				title: `Filter Keys of db${node.db}`,
				prompt: 'A SCAN MATCH pattern: * any characters, ? one character, [abc] one of them. Leave empty for all keys.',
				value: filter.pattern(node.source.id, node.db),
				placeHolder: 'user:*',
			});
			if (pattern !== undefined) {
				await filter.setPattern(node.source.id, node.db, pattern.trim());
			}
		}),
		guarded('columbus.redis.newKey', async node => {
			const target = node as DbNode | FolderNode;
			if (target.kind !== 'redisDb' && target.kind !== 'redisFolder') {
				return;
			}
			const type = await vscode.window.showQuickPick(Object.keys(INITIAL), { title: 'New Key', placeHolder: 'Type of the new key' });
			if (!type) {
				return;
			}
			const name = await vscode.window.showInputBox({ title: `New ${type} Key`, value: target.kind === 'redisFolder' ? target.prefix : '', valueSelection: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] });
			if (!name) {
				return;
			}
			const exists = await target.source.driver.command(target.db, ['EXISTS', name]);
			if (exists === 1) {
				throw new Error(`The key ${name} already exists`);
			}
			await target.source.driver.command(target.db, INITIAL[type](name));
			refresh(target.source);
			await openKey(extensionUri, { source: target.source, db: target.db, key: name }, type, () => refresh(target.source));
		}),
		guarded('columbus.redis.copyKey', node => node.kind === 'redisKey' && vscode.env.clipboard.writeText(node.key.name)),
		guarded('columbus.redis.renameKey', async node => {
			const target = node as KeyNode;
			if (target.kind !== 'redisKey') {
				return;
			}
			const name = await vscode.window.showInputBox({ title: 'Rename Key', value: target.key.name });
			if (!name || name === target.key.name) {
				return;
			}
			const renamed = target.key.bytes && /^0x(?:[0-9a-f]{2})+$/i.test(name) ? Uint8Array.from(Buffer.from(name.slice(2), 'hex')) : name;
			if (await target.source.driver.command(target.db, ['RENAMENX', nameArg(target.key), renamed]) !== 1) {
				throw new Error(`The key ${name} already exists`);
			}
			refresh(target.source);
		}),
		guarded('columbus.redis.expireKey', async node => {
			const target = node as KeyNode;
			if (target.kind !== 'redisKey') {
				return;
			}
			const current = target.key.ttl > 0 ? String(Math.ceil(target.key.ttl / 1000)) : '';
			const value = await vscode.window.showInputBox({
				title: `Time to Live of ${target.key.name}`,
				prompt: 'Seconds until the key expires; leave empty to keep it forever',
				value: current,
				validateInput: text => (!text.trim() || /^\d+$/.test(text.trim()) ? undefined : 'Enter whole seconds'),
			});
			if (value === undefined) {
				return;
			}
			await target.source.driver.command(target.db, value.trim() ? ['EXPIRE', nameArg(target.key), value.trim()] : ['PERSIST', nameArg(target.key)]);
			refresh(target.source);
		}),
		guarded('columbus.redis.deleteKey', async node => {
			const target = node as KeyNode | FolderNode;
			if (target.kind !== 'redisKey' && target.kind !== 'redisFolder') {
				return;
			}
			const keys = target.kind === 'redisKey' ? [target.key] : target.keys;
			const what = target.kind === 'redisKey' ? `key "${keys[0].name}"` : `${keys.length} keys under "${target.prefix}"`;
			const answer = await vscode.window.showWarningMessage(`Delete the ${what}?`, { modal: true, detail: keys.slice(0, 10).map(k => k.name).join('\n') + (keys.length > 10 ? '\n…' : '') }, 'Delete');
			if (answer !== 'Delete') {
				return;
			}
			for (let i = 0; i < keys.length; i += 500) {
				await target.source.driver.command(target.db, ['UNLINK', ...keys.slice(i, i + 500).map(nameArg)]);
			}
			refresh(target.source);
		}),
		vscode.commands.registerCommand('columbus.redis.chooseDatabase', () => consoles.chooseDatabase()),
	];
}
