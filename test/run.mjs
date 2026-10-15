import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'out-test', 'integration');

execFileSync('node', ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });
rmSync(outDir, { recursive: true, force: true });
await build({
	entryPoints: {
		editor: join(root, 'src/test/integration/editor.test.ts'),
		project: join(root, 'src/test/integration/project.test.ts'),
	},
	outdir: outDir,
	outExtension: { '.js': '.test.js' },
	bundle: true,
	platform: 'node',
	format: 'cjs',
	external: ['vscode'],
	logLevel: 'warning',
});

const exe = await downloadAndUnzipVSCode({
	version: process.env.COLUMBUS_VSCODE_VERSION ?? 'stable',
	cachePath: process.env.COLUMBUS_VSCODE_CACHE ?? join(root, '.vscode-test'),
});

const profile = realpathSync(mkdtempSync(join(tmpdir(), 'cb-')));
const project = join(profile, 'project');
mkdirSync(join(project, '.columbus'), { recursive: true });
writeFileSync(join(project, '.columbus', 'state.json'), JSON.stringify({
	'columbus.dataSources': [
		{ id: 'seeded', name: 'seeded', driver: 'redis', host: '127.0.0.1', port: 1, database: '0', user: '', ssl: 'disable' },
		{ id: '../escape', name: 'escape', driver: 'redis', host: '127.0.0.1', port: 1, database: '0', user: '', ssl: 'disable' },
	],
}));
const run = (name, userData, folder) => runTests({
	vscodeExecutablePath: exe,
	extensionDevelopmentPath: root,
	extensionTestsPath: join(root, 'test', 'runner.cjs'),
	extensionTestsEnv: { COLUMBUS_TEST_FILES: JSON.stringify([join(outDir, `${name}.test.js`)]), COLUMBUS_PG_URL: process.env.COLUMBUS_PG_URL ?? '', COLUMBUS_REDIS_URL: process.env.COLUMBUS_REDIS_URL ?? '' },
	launchArgs: [...(folder ? [folder] : []), '--disable-extensions', '--user-data-dir', join(profile, userData), '--disable-workspace-trust'],
});
try {
	await run('editor', 'ud');
	await run('project', 'up', project);
} finally {
	rmSync(profile, { recursive: true, force: true });
}
