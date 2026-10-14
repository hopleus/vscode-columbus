import type { DriverKind, RedisMode, SshAuth, SslMode } from '../drivers/connection';

export interface Secrets {
	password?: string;
	sshPassword?: string;
	sslPassphrase?: string;
}

export type SslFileField = 'sslCa' | 'sslCert' | 'sslKey';

export interface SshFields {
	host: string;
	port: number;
	user: string;
	auth: SshAuth;
	keyFile?: string;
}

export interface SourceFields {
	name: string;
	driver: DriverKind;
	host: string;
	port: number;
	database: string;
	user: string;
	ssl: SslMode;
	sslCa?: string;
	sslCert?: string;
	sslKey?: string;
	mode?: RedisMode;
	master?: string;
	ssh?: SshFields;
}

export interface DriverInfo {
	kind: DriverKind;
	label: string;
	status: 'ready' | 'outdated' | 'missing' | 'downloading' | 'failed';
	library: string;
	version: string;
	previousVersion?: string;
	size: number;
	error?: string;
}

export type FormHostMessage =
	| { type: 'driver'; driver: DriverInfo }
	| { type: 'init'; source: SourceFields | undefined; hasPassword: boolean; hasSshPassword: boolean; hasSslPassphrase: boolean }
	| { type: 'keyFile'; path: string }
	| { type: 'sslFile'; field: SslFileField; path: string }
	| { type: 'tested'; requestId: number; ok: boolean; message: string }
	| { type: 'failed'; message: string; canForce: boolean }
	| { type: 'file'; path: string };

export type FormViewMessage =
	| { type: 'ready' }
	| { type: 'test'; requestId: number; fields: SourceFields; secrets: Secrets }
	| { type: 'save'; fields: SourceFields; secrets: Secrets; force: boolean }
	| { type: 'browseKey'; path: string }
	| { type: 'browseSslFile'; field: SslFileField; path: string }
	| { type: 'cancel' }
	| { type: 'driverState'; kind: DriverKind }
	| { type: 'downloadDriver'; kind: DriverKind }
	| { type: 'stop' }
	| { type: 'browse'; path: string }
	| { type: 'createFile'; path: string };
