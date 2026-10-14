import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'src', 'test');
const outDir = join(root, 'out-test');

rmSync(outDir, { recursive: true, force: true });
const entries = readdirSync(srcDir).filter(f => f.endsWith('.test.ts')).map(f => join(srcDir, f));
await build({
	entryPoints: entries,
	outdir: outDir,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	external: ['cpu-features', '*.node'],
	logLevel: 'warning',
});

const files = readdirSync(outDir).filter(f => f.endsWith('.test.js')).map(f => join(outDir, f));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
