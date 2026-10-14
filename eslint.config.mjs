import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['out/**', 'out-test/**', '.build/**', '.vscode-test/**', 'node_modules/**', 'test/runner.cjs'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
			eqeqeq: 'error',
			curly: ['error', 'all'],
		},
	}
);
