import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const drivers = ['postgres', 'mysql', 'sqlite', 'redis', 'ssh'];
const assists = ['postgres', 'mysql'];

const targets = [
	{
		entryPoints: ['src/extension.ts'],
		outfile: 'out/extension.js',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		external: ['vscode'],
		sourcemap: true,
		minify: !watch,
	},
	{
		entryPoints: {
			worker: 'src/worker/main.ts',
			'assist-worker': 'src/assist/worker.ts',
			...Object.fromEntries(drivers.map(name => [`drivers/${name}`, `src/drivers/${name}.ts`])),
			...Object.fromEntries(assists.map(name => [`assist/${name}`, `src/assist/${name}.ts`])),
		},
		outdir: 'out',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		external: ['pg-native', 'cpu-features', '*.node'],
		sourcemap: true,
		minify: !watch,
	},
	{
		entryPoints: {
			webview: 'src/webview/main.ts',
			'webview-style': 'src/webview/style.css',
			form: 'src/webview/form.ts',
			results: 'src/webview/results.ts',
			'form-style': 'src/webview/form.css',
		},
		outdir: 'out',
		bundle: true,
		platform: 'browser',
		format: 'iife',
		target: 'chrome120',
		sourcemap: true,
		minify: !watch,
	},
];

if (watch) {
	for (const options of targets) {
		await (await context(options)).watch();
	}
} else {
	await Promise.all(targets.map(options => build(options)));
	const libraries = { postgres: 'pg', mysql: 'mysql2', redis: 'iovalkey', ssh: 'ssh2' };
	const versionOf = name => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
	const entry = (file, asset, library) => {
		const data = readFileSync(file);
		return { file: asset, sha256: createHash('sha256').update(data).digest('hex'), size: data.length, ...(library ? { library, version: versionOf(library) } : {}) };
	};
	const manifest = Object.fromEntries([
		...drivers.map(name => [name, entry(`out/drivers/${name}.js`, `columbus-driver-${name}.js`, libraries[name])]),
		...assists.map(name => [`assist-${name}`, entry(`out/assist/${name}.js`, `columbus-assist-${name}.js`, 'dt-sql-parser')]),
	]);
	writeFileSync('out/drivers.json', JSON.stringify(manifest));
}
