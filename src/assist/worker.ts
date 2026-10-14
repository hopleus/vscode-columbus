import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import type { Analysis } from './engine';

console.error = () => undefined;
console.log = () => undefined;

const load = createRequire(__filename);
const engine = (load((workerData as { module: string }).module) as { create(): { analyze(statement: string, offset: number): Analysis } }).create();
const warmup = 'SELECT a FROM t AS x JOIN u ON x.a = u.b WHERE ';
engine.analyze(warmup, warmup.length);

parentPort?.on('message', (request: { id: number; statement: string; offset: number }) => {
	try {
		parentPort?.postMessage({ id: request.id, result: engine.analyze(request.statement, request.offset) });
	} catch (err) {
		parentPort?.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) });
	}
});
