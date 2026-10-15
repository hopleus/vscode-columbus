import * as vscode from 'vscode';
import type { Catalog } from './catalog';
import type { Product } from './drivers/connection';
import type { Driver } from './drivers/driver';
import type { RemoteRedis } from './drivers/remote';

interface SourceBase {
	id: string;
	name: string;
	removable: boolean;
	global: boolean;
	product?: Product;
	remember?(product: Product): void;
}

export interface DataSource extends SourceBase {
	driver: Driver;
	kind?: 'postgres' | 'mysql' | 'sqlite';
}

export interface RedisSource extends SourceBase {
	driver: RemoteRedis;
	kind: 'redis';
	database: number;
}

export type AnySource = DataSource | RedisSource;

export function isRedis(source: AnySource): source is RedisSource {
	return source.kind === 'redis';
}

export class Sources implements vscode.Disposable {
	private readonly items: AnySource[] = [];
	private readonly catalogs = new Map<string, Promise<Catalog>>();
	private readonly loadedCatalogs = new Map<string, Catalog>();
	private readonly _onDidLoadCatalog = new vscode.EventEmitter<string>();
	readonly onDidLoadCatalog = this._onDidLoadCatalog.event;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly connections = new Set<string>();
	private readonly _onDidChangeConnection = new vscode.EventEmitter<string>();
	readonly onDidChangeConnection = this._onDidChangeConnection.event;

	constructor(private readonly databases: (id: string) => string[] | undefined = () => undefined) { }

	dispose(): void {
		for (const source of this.items) {
			source.driver.dispose();
		}
		this._onDidChange.dispose();
		this._onDidChangeConnection.dispose();
		this._onDidLoadCatalog.dispose();
	}

	loaded(id: string): Catalog | undefined {
		return this.loadedCatalogs.get(id);
	}

	isConnected(id: string): boolean {
		return this.connections.has(id);
	}

	setConnected(id: string, connected: boolean): void {
		if (this.connections.has(id) !== connected) {
			if (connected) {
				this.connections.add(id);
			} else {
				this.connections.delete(id);
			}
			this._onDidChangeConnection.fire(id);
		}
	}

	add(source: AnySource): void {
		this.items.push(source);
		this._onDidChange.fire();
	}

	replace(source: AnySource): void {
		const index = this.items.findIndex(s => s.id === source.id);
		if (index < 0) {
			this.add(source);
			return;
		}
		this.items[index].driver.dispose();
		this.items[index] = source;
		this.catalogs.delete(source.id);
		this._onDidChange.fire();
	}

	setGlobal(id: string, global: boolean): void {
		const source = this.get(id);
		if (source && source.global !== global) {
			source.global = global;
			this._onDidChange.fire();
		}
	}

	remove(id: string): void {
		const index = this.items.findIndex(s => s.id === id);
		if (index < 0) {
			return;
		}
		this.items[index].driver.dispose();
		this.items.splice(index, 1);
		this.catalogs.delete(id);
		this.loadedCatalogs.delete(id);
		this._onDidChange.fire();
	}

	list(): readonly AnySource[] {
		return this.items;
	}

	get(id: string): AnySource | undefined {
		return this.items.find(s => s.id === id);
	}

	sql(id: string): DataSource | undefined {
		const source = this.get(id);
		return source && !isRedis(source) ? source : undefined;
	}

	catalog(source: DataSource): Promise<Catalog> {
		let catalog = this.catalogs.get(source.id);
		if (!catalog) {
			catalog = source.driver.catalog(this.databases(source.id));
			catalog.then(loaded => {
				if (this.catalogs.get(source.id) === catalog) {
					this.loadedCatalogs.set(source.id, loaded);
					this._onDidLoadCatalog.fire(source.id);
				}
			}, () => this.catalogs.delete(source.id));
			this.catalogs.set(source.id, catalog);
		}
		return catalog;
	}

	refresh(id?: string): void {
		if (id) {
			this.catalogs.delete(id);
		} else {
			this.catalogs.clear();
		}
		this._onDidChange.fire();
	}
}
