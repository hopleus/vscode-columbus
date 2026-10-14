import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { createVSIX, listFiles, PackageManager } from '@vscode/vsce';

const out = resolve(process.argv[2] ?? '.build');
const stage = resolve('.build/vsix');

const minifiers = {
	'.json': text => JSON.stringify(JSON.parse(text)),
	'.svg': text => text.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').replace(/\s*\/>/g, '/>').trim(),
	'.js': text => text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, ''),
	'.css': text => text.replace(/\n\/\*# sourceMappingURL=\S+ \*\/\s*$/, ''),
};

const manifest = ({ scripts, devDependencies, ...rest }) => rest;

rmSync(stage, { recursive: true, force: true });
let before = 0;
let after = 0;
for (const file of await listFiles({ packageManager: PackageManager.None })) {
	const target = join(stage, file);
	mkdirSync(dirname(target), { recursive: true });
	const minify = minifiers[extname(file)];
	if (file === 'package.json') {
		writeFileSync(target, JSON.stringify(manifest(JSON.parse(readFileSync(file, 'utf8')))));
	} else if (minify) {
		writeFileSync(target, minify(readFileSync(file, 'utf8')));
	} else {
		copyFileSync(file, target);
	}
	before += statSync(file).size;
	after += statSync(target).size;
}
console.log(`Minified ${(before / 1024).toFixed(1)} KB to ${(after / 1024).toFixed(1)} KB`);

mkdirSync(out, { recursive: true });
await createVSIX({ cwd: stage, packagePath: out, dependencies: false });
