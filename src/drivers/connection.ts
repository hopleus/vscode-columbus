import type { Flavor } from '../shared/format';

export type DriverKind = 'postgres' | 'mysql' | 'sqlite' | 'redis';

export type Product = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'redis' | 'valkey' | 'dragonfly';

const PRODUCTS: [RegExp, Product][] = [
	[/^mariadb/i, 'mariadb'], [/^mysql/i, 'mysql'], [/^postgresql/i, 'postgres'], [/^sqlite/i, 'sqlite'], [/^valkey/i, 'valkey'], [/^dragonfly/i, 'dragonfly'], [/^redis/i, 'redis'],
];

export function productOf(version: string): Product | undefined {
	return PRODUCTS.find(([pattern]) => pattern.test(version))?.[1];
}

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export type SshAuth = 'password' | 'key' | 'agent';

export interface SshConfig {
	host: string;
	port: number;
	user: string;
	auth: SshAuth;
	keyFile?: string;
	password?: string;
	fingerprint?: string;
}

export type RedisMode = 'cluster' | 'sentinel';

export interface ConnectionConfig {
	driver: DriverKind;
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl: SslMode;
	sslCa?: string;
	sslCert?: string;
	sslKey?: string;
	sslPassphrase?: string;
	mode?: RedisMode;
	master?: string;
	ssh?: SshConfig;
	servername?: string;
}

export const TRUST = /^SSH host (?:key of )?(\S+?):(\d+) (?:is not trusted yet|(changed)) \(key (SHA256:[^)]+)\)/;

export interface DriverInfo {
	label: string;
	module: string;
	port: number;
	flavor?: Flavor;
	schemes: string[];
	secureSchemes?: string[];
	example: string;
}

export const DRIVERS: Record<DriverKind, DriverInfo> = {
	postgres: {
		label: 'PostgreSQL',
		module: 'postgres',
		port: 5432,
		flavor: 'postgres',
		schemes: ['postgresql:', 'postgres:'],
		example: 'postgresql://user:password@localhost:5432/postgres',
	},
	mysql: {
		label: 'MySQL / MariaDB',
		module: 'mysql',
		port: 3306,
		flavor: 'mysql',
		schemes: ['mysql:', 'mariadb:'],
		example: 'mysql://user:password@localhost:3306/database',
	},
	sqlite: {
		label: 'SQLite',
		module: 'sqlite',
		port: 0,
		flavor: 'sqlite',
		schemes: ['sqlite:', 'file:'],
		example: 'sqlite:/path/to/database.db',
	},
	redis: {
		label: 'Redis / Valkey / Dragonfly',
		module: 'redis',
		port: 6379,
		schemes: ['redis:', 'rediss:', 'valkey:', 'valkeys:', 'dragonfly:', 'redis+cluster:', 'rediss+cluster:', 'redis+sentinel:', 'rediss+sentinel:'],
		secureSchemes: ['rediss:', 'valkeys:', 'rediss+cluster:', 'rediss+sentinel:'],
		example: 'redis://user:password@localhost:6379/0',
	},
};

const SSL: Record<string, SslMode> = {
	disable: 'disable',
	disabled: 'disable',
	allow: 'disable',
	prefer: 'disable',
	preferred: 'disable',
	require: 'require',
	required: 'require',
	'verify-ca': 'verify-ca',
	'verify-full': 'verify-full',
	'verify-identity': 'verify-full',
};

const SSL_FILES: Partial<Record<DriverKind, [keyof Pick<ConnectionConfig, 'sslCa' | 'sslCert' | 'sslKey'>, string][]>> = {
	postgres: [['sslCa', 'sslrootcert'], ['sslCert', 'sslcert'], ['sslKey', 'sslkey']],
	mysql: [['sslCa', 'ssl-ca'], ['sslCert', 'ssl-cert'], ['sslKey', 'ssl-key']],
};

function parseFileUrl(text: string): ConnectionConfig {
	const match = /^(sqlite|file):(.*)$/is.exec(text.trim());
	if (!match) {
		throw new Error(`Expected a URL like ${DRIVERS.sqlite.example}`);
	}
	let path = match[2].startsWith('//') ? match[2].slice(2) : match[2];
	if (match[1].toLowerCase() === 'file') {
		path = decodeURIComponent(path);
	}
	if (!path) {
		throw new Error('The URL has no file path');
	}
	return { driver: 'sqlite', host: '', port: 0, database: path, user: '', password: '', ssl: 'disable' };
}

export function parseUrl(driver: DriverKind, text: string): ConnectionConfig {
	if (driver === 'sqlite') {
		return parseFileUrl(text);
	}
	const info = DRIVERS[driver];
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		throw new Error(`Expected a URL like ${info.example}`);
	}
	if (!info.schemes.includes(url.protocol)) {
		throw new Error(`The URL must start with ${info.schemes.map(s => `${s}//`).join(' or ')}`);
	}
	if (!url.hostname) {
		throw new Error('The URL has no host');
	}
	const sslmode = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode') ?? (info.secureSchemes?.includes(url.protocol) ? 'require' : 'disable');
	const ssl = SSL[sslmode.toLowerCase().replace(/_/g, '-')];
	if (!ssl) {
		throw new Error(`Unknown sslmode '${sslmode}'`);
	}
	const user = decodeURIComponent(url.username);
	const mode = /\+(cluster|sentinel):$/.exec(url.protocol)?.[1] as RedisMode | undefined;
	const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
	const master = mode === 'sentinel' ? path.split('/')[0] : undefined;
	const database = mode === 'sentinel' ? path.split('/')[1] ?? '' : path;
	if (mode === 'sentinel' && !master) {
		throw new Error('The URL has no master name: redis+sentinel://host:26379/mymaster/0');
	}
	return {
		driver,
		host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
		port: url.port ? Number(url.port) : mode === 'sentinel' ? 26379 : info.port,
		database: mode === 'cluster' ? '0' : database || (driver === 'postgres' ? user || 'postgres' : driver === 'redis' ? '0' : ''),
		user,
		password: decodeURIComponent(url.password),
		ssl,
		...(mode ? { mode } : {}),
		...(master ? { master } : {}),
		...Object.fromEntries((SSL_FILES[driver] ?? []).flatMap(([field, name]) => {
			const value = url.searchParams.get(name) ?? url.searchParams.get(name.replace(/-/g, '_'));
			return value ? [[field, value]] : [];
		})),
	};
}

export function formatUrl(config: Omit<ConnectionConfig, 'password'>): string {
	if (config.driver === 'sqlite') {
		return `sqlite:${config.database}`;
	}
	const info = DRIVERS[config.driver];
	const user = config.user ? `${encodeURIComponent(config.user)}@` : '';
	const host = config.host.includes(':') ? `[${config.host}]` : config.host;
	const path = config.mode === 'sentinel' ? `${config.master ?? ''}/${config.database}` : config.mode === 'cluster' ? '' : config.database;
	const database = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
	const secure = info.secureSchemes && config.ssl !== 'disable';
	const params: string[] = [];
	if (config.ssl !== 'disable' && !(secure && config.ssl === 'require')) {
		params.push(`sslmode=${config.ssl}`);
	}
	for (const [field, name] of config.ssl === 'disable' ? [] : SSL_FILES[config.driver] ?? []) {
		if (config[field]) {
			params.push(`${name}=${encodeURIComponent(config[field]).replace(/%2F/g, '/')}`);
		}
	}
	const query = params.length ? `?${params.join('&')}` : '';
	const scheme = `${secure ? info.secureSchemes![0] : info.schemes[0]}`.replace(/:$/, config.mode ? `+${config.mode}:` : ':');
	return `${scheme}//${user}${host}:${config.port}${database}${query}`;
}
