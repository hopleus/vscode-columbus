import type { Change, GridColumn, Row, Value } from './protocol';

export type RowState = 'clean' | 'added' | 'removed' | 'updated';

export class Edits {
	private readonly updated = new Map<number, Map<number, Value>>();
	private readonly removed = new Set<number>();
	private added: Map<number, Value>[] = [];
	private readonly expressions = new WeakMap<Map<number, Value>, Set<number>>();

	constructor(private readonly base: readonly Value[][]) { }

	get loadedCount(): number {
		return this.base.length;
	}

	get rowCount(): number {
		return this.base.length + this.added.length;
	}

	get dirty(): boolean {
		return this.updated.size > 0 || this.removed.size > 0 || this.added.length > 0;
	}

	isAdded(row: number): boolean {
		return row >= this.base.length;
	}

	value(row: number, col: number): Value | undefined {
		if (this.isAdded(row)) {
			return this.added[row - this.base.length]?.get(col);
		}
		const cells = this.updated.get(row);
		return cells?.has(col) ? cells.get(col) : this.base[row]?.[col];
	}

	original(row: number, col: number): Value | undefined {
		return this.isAdded(row) ? undefined : this.base[row]?.[col];
	}

	state(row: number): RowState {
		if (this.isAdded(row)) {
			return 'added';
		}
		if (this.removed.has(row)) {
			return 'removed';
		}
		return this.updated.has(row) ? 'updated' : 'clean';
	}

	isExpression(row: number, col: number): boolean {
		const cells = this.isAdded(row) ? this.added[row - this.base.length] : this.updated.get(row);
		return !!cells && (this.expressions.get(cells)?.has(col) ?? false);
	}

	setExpression(row: number, col: number, sql: string): void {
		if (!this.isAdded(row) && (this.removed.has(row) || !this.base[row])) {
			return;
		}
		const cells = this.isAdded(row) ? this.added[row - this.base.length] : this.updated.get(row) ?? new Map<number, Value>();
		if (!cells) {
			return;
		}
		cells.set(col, sql);
		const marks = this.expressions.get(cells) ?? new Set<number>();
		marks.add(col);
		this.expressions.set(cells, marks);
		if (!this.isAdded(row)) {
			this.updated.set(row, cells);
		}
	}

	isModified(row: number, col: number): boolean {
		return this.isAdded(row) ? this.added[row - this.base.length]?.has(col) ?? false : this.updated.get(row)?.has(col) ?? false;
	}

	set(row: number, col: number, value: Value): void {
		if (this.isAdded(row)) {
			const added = this.added[row - this.base.length];
			added?.set(col, value);
			if (added) {
				this.expressions.get(added)?.delete(col);
			}
			return;
		}
		if (this.removed.has(row) || !this.base[row]) {
			return;
		}
		const cells = this.updated.get(row) ?? new Map<number, Value>();
		this.expressions.get(cells)?.delete(col);
		if (this.base[row][col] === value) {
			cells.delete(col);
		} else {
			cells.set(col, value);
		}
		if (cells.size) {
			this.updated.set(row, cells);
		} else {
			this.updated.delete(row);
		}
	}

	add(): number {
		this.added.push(new Map());
		return this.rowCount - 1;
	}

	remove(rows: readonly number[]): void {
		const dropped = new Set<number>();
		for (const row of rows) {
			if (this.isAdded(row)) {
				dropped.add(row - this.base.length);
			} else if (this.base[row]) {
				this.removed.add(row);
			}
		}
		this.added = this.added.filter((_, i) => !dropped.has(i));
	}

	revert(rows: readonly number[]): void {
		const dropped = new Set<number>();
		for (const row of rows) {
			if (this.isAdded(row)) {
				dropped.add(row - this.base.length);
			} else {
				this.updated.delete(row);
				this.removed.delete(row);
			}
		}
		this.added = this.added.filter((_, i) => !dropped.has(i));
	}

	revertAll(): void {
		this.updated.clear();
		this.removed.clear();
		this.added = [];
	}

	changes(columns: readonly GridColumn[]): Change[] {
		const primary = columns.flatMap((c, i) => c.primary ? [i] : []);
		const keyColumns = primary.length ? primary : columns.map((_, i) => i);
		const key = (row: number): Row => Object.fromEntries(keyColumns.map(i => [columns[i].name, this.base[row][i]]));
		const pick = (cells: Map<number, Value>): { values: Row; expressions?: Record<string, string> } => {
			const marks = this.expressions.get(cells);
			const sorted = [...cells].sort(([a], [b]) => a - b);
			const values = Object.fromEntries(sorted.filter(([i]) => !marks?.has(i)).map(([i, v]) => [columns[i].name, v]));
			const expressions = sorted.filter(([i]) => marks?.has(i)).map(([i, v]) => [columns[i].name, String(v)]);
			return expressions.length ? { values, expressions: Object.fromEntries(expressions) } : { values };
		};

		const result: Change[] = [];
		for (const row of [...this.removed].sort((a, b) => a - b)) {
			result.push({ kind: 'delete', key: key(row) });
		}
		for (const [row, cells] of [...this.updated].sort(([a], [b]) => a - b)) {
			if (!this.removed.has(row)) {
				result.push({ kind: 'update', key: key(row), ...pick(cells) });
			}
		}
		for (const cells of this.added) {
			result.push({ kind: 'insert', ...pick(cells) });
		}
		return result;
	}
}
