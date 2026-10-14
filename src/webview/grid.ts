import { Edits } from '../shared/edits';
import { display } from '../shared/format';
import type { SortKey } from '../shared/format';
import type { GridColumn, Value } from '../shared/protocol';
import { icons } from './icons';

export interface Cell {
	row: number;
	col: number;
}

interface Selection {
	anchor: Cell;
	focus: Cell;
	rows: boolean;
	cols: boolean;
}

export interface Range {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

const OVERSCAN = 8;
const MEASURED_ROWS = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}

export class Grid {
	readonly element = el('div', 'grid');
	onEdit: () => void = () => undefined;
	onSelect: () => void = () => undefined;
	onSort: (sort: SortKey[]) => void = () => undefined;
	onMatches: (index: number, total: number) => void = () => undefined;
	onContext: (cell: Cell | undefined) => void = () => undefined;
	copyText: (columns: GridColumn[], rows: Value[][]) => string = (_, rows) =>
		rows.map(row => row.map(v => v === null ? '' : String(v)).join('\t')).join('\n');

	private readonly canvas = el('div', 'canvas');
	private readonly header = el('div', 'header');
	private readonly body = el('div', 'body');
	private columns: GridColumn[] = [];
	private readOnly = false;
	private edits = new Edits([]);
	private offset = 0;
	private sort: SortKey[] = [];
	private widths: number[] = [];
	private gutter = 40;
	private rowHeight = 23;
	private headerHeight = 28;
	private fontSize = 13;
	private fontFamily = 'monospace';
	private selection: Selection | undefined;
	private editing: { input: HTMLInputElement; cell: Cell; initial: string } | undefined;
	private rendered = { first: -1, last: -1 };
	private pattern: RegExp | undefined;
	private matches: Cell[] = [];
	private matchKeys = new Set<string>();
	private matchIndex = -1;
	private frame = 0;

	constructor() {
		this.element.tabIndex = 0;
		this.canvas.append(this.header, this.body);
		this.element.append(this.canvas);
		this.element.addEventListener('scroll', () => this.schedule());
		this.element.addEventListener('keydown', e => this.keydown(e));
		this.body.addEventListener('mousedown', e => this.bodyMousedown(e));
		this.header.addEventListener('mousedown', e => this.headerMousedown(e));
		document.addEventListener('copy', e => this.copy(e));
		new ResizeObserver(() => this.schedule()).observe(this.element);
		this.readMetrics();
	}

	setColumns(columns: GridColumn[], readOnly: boolean): void {
		this.columns = columns;
		this.readOnly = readOnly;
		this.widths = [];
		this.selection = undefined;
	}

	setRows(edits: Edits, offset: number): void {
		this.cancelEdit();
		this.edits = edits;
		this.offset = offset;
		if (!this.widths.length) {
			this.measure();
		}
		if (this.selection) {
			const last = Math.max(0, edits.rowCount - 1);
			this.selection.anchor.row = Math.min(this.selection.anchor.row, last);
			this.selection.focus.row = Math.min(this.selection.focus.row, last);
		}
		this.element.scrollTop = 0;
		this.collectMatches();
		this.renderAll();
		this.onSelect();
	}

	setSort(sort: SortKey[]): void {
		this.sort = sort;
		this.renderHeader();
	}

	refresh(): void {
		this.collectMatches();
		this.renderAll();
		this.onSelect();
	}

	search(pattern: RegExp | undefined): void {
		this.pattern = pattern;
		this.matchIndex = -1;
		this.collectMatches();
		this.renderAll();
	}

	step(delta: number): void {
		const total = this.matches.length;
		if (!total) {
			return;
		}
		const focus = this.selection?.focus;
		const position = (cell: Cell): number => cell.row * this.columns.length + cell.col;
		const current = focus ? position(focus) : -1;
		let index = delta > 0 ? this.matches.findIndex(m => position(m) > current) : this.matches.findLastIndex(m => position(m) < current);
		if (index < 0) {
			index = delta > 0 ? 0 : total - 1;
		}
		this.matchIndex = index;
		this.revealMatch();
	}

	selectedRange(): Range | undefined {
		return this.range();
	}

	focused(): Cell | undefined {
		return this.selection?.focus;
	}

	selectionData(): { columns: GridColumn[]; rows: Value[][] } | undefined {
		const range = this.range();
		if (!range) {
			return undefined;
		}
		const rows: Value[][] = [];
		for (let row = range.top; row <= range.bottom; row++) {
			const values: Value[] = [];
			for (let col = range.left; col <= range.right; col++) {
				values.push(this.edits.value(row, col) ?? null);
			}
			rows.push(values);
		}
		return { columns: this.columns.slice(range.left, range.right + 1), rows };
	}

	setValue(row: number, col: number, value: Value): void {
		this.edits.set(row, col, value);
		this.collectMatches();
		this.renderAll();
		this.onEdit();
	}

	startEdit(): void {
		this.edit();
	}

	selectedRows(): number[] {
		const range = this.range();
		if (!range) {
			return [];
		}
		return Array.from({ length: range.bottom - range.top + 1 }, (_, i) => range.top + i);
	}

	focusCell(row: number, col: number): void {
		this.selection = { anchor: { row, col }, focus: { row, col }, rows: false, cols: false };
		this.reveal({ row, col });
		this.renderAll();
		this.element.focus();
		this.onSelect();
	}

	commitEdit(): void {
		const editing = this.editing;
		if (!editing) {
			return;
		}
		this.editing = undefined;
		editing.input.remove();
		const text = editing.input.value;
		if (text === editing.initial) {
			return;
		}
		const { row, col } = editing.cell;
		const original = this.edits.original(row, col);
		const value: Value = original !== undefined && original !== null && String(original) === text ? original : text;
		this.edits.set(row, col, value);
		this.collectMatches();
		this.renderAll();
		this.onEdit();
	}

	private cancelEdit(): void {
		const editing = this.editing;
		this.editing = undefined;
		editing?.input.remove();
	}

	private collectMatches(): void {
		this.matches = [];
		const pattern = this.pattern;
		if (pattern) {
			for (let row = 0; row < this.edits.rowCount; row++) {
				for (let col = 0; col < this.columns.length; col++) {
					const value = this.edits.value(row, col);
					if (value !== null && value !== undefined && pattern.test(String(value))) {
						this.matches.push({ row, col });
					}
				}
			}
		}
		this.matchKeys = new Set(this.matches.map(m => `${m.row}:${m.col}`));
		this.matchIndex = Math.min(this.matchIndex, this.matches.length - 1);
		this.onMatches(this.matchIndex + 1, this.matches.length);
	}

	private revealMatch(): void {
		const cell = this.matches[this.matchIndex];
		this.selection = { anchor: { ...cell }, focus: { ...cell }, rows: false, cols: false };
		this.reveal(cell);
		this.renderAll();
		this.onSelect();
		this.onMatches(this.matchIndex + 1, this.matches.length);
	}

	private readMetrics(): void {
		const style = getComputedStyle(document.documentElement);
		this.fontSize = parseFloat(style.getPropertyValue('--vscode-editor-font-size')) || 13;
		this.fontFamily = style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
		this.rowHeight = Math.round(this.fontSize * 1.4) + 5;
		this.headerHeight = this.rowHeight + 5;
		this.element.style.setProperty('--row-height', `${this.rowHeight}px`);
		this.element.style.setProperty('--header-height', `${this.headerHeight}px`);
	}

	private measure(): void {
		const context = document.createElement('canvas').getContext('2d');
		if (!context) {
			this.widths = this.columns.map(() => 120);
			return;
		}
		context.font = `${this.fontSize}px ${this.fontFamily}`;
		const rows = Math.min(this.edits.rowCount, MEASURED_ROWS);
		this.widths = this.columns.map((column, col) => {
			let width = context.measureText(column.name).width + 56;
			for (let row = 0; row < rows; row++) {
				width = Math.max(width, context.measureText(display(this.edits.value(row, col), column).text.slice(0, 80)).width + 14);
			}
			return Math.ceil(Math.min(Math.max(width, 64), 360));
		});
	}

	private updateGutter(): void {
		const context = document.createElement('canvas').getContext('2d');
		const digits = String(this.offset + Math.max(this.edits.rowCount, 1)).length;
		if (context) {
			context.font = `${this.fontSize}px ${this.fontFamily}`;
		}
		const width = context ? context.measureText('0'.repeat(digits)).width : digits * this.fontSize * 0.6;
		this.gutter = Math.ceil(Math.max(width + 24, 40));
	}

	private schedule(): void {
		if (this.frame) {
			return;
		}
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.renderBody(false);
		});
	}

	private renderAll(): void {
		this.updateGutter();
		this.renderHeader();
		this.renderBody(true);
		if (this.editing) {
			this.placeEditor(this.editing.input, this.editing.cell);
		}
	}

	private renderHeader(): void {
		const total = this.gutter + this.widths.reduce((a, b) => a + b, 0);
		this.canvas.style.width = `${total}px`;
		const range = this.range();
		const corner = el('div', 'corner');
		corner.style.width = `${this.gutter}px`;
		const cells: HTMLElement[] = [corner];
		this.columns.forEach((column, col) => {
			const th = el('div', 'th');
			th.style.width = `${this.widths[col]}px`;
			if (range && col >= range.left && col <= range.right) {
				th.classList.add('selected');
			}
			const icon = el('span', 'th-icon');
			icon.innerHTML = column.primary ? icons.columnKey : column.foreign ? icons.columnForeign : icons.column;
			const name = el('span', 'th-name');
			name.textContent = column.name;
			th.title = column.type;
			const sort = el('span', 'th-sort');
			const index = this.sort.findIndex(s => s.column === column.name);
			if (index >= 0) {
				sort.classList.add(this.sort[index].desc ? 'desc' : 'asc');
				if (this.sort.length > 1) {
					sort.dataset.order = String(index + 1);
				}
			}
			sort.innerHTML = icons.sort;
			const resizer = el('span', 'resizer');
			th.append(icon, name, sort, resizer);
			cells.push(th);
		});
		this.header.replaceChildren(...cells);
	}

	private renderBody(force: boolean): void {
		const count = this.edits.rowCount;
		this.body.style.height = `${count * this.rowHeight}px`;
		const top = Math.max(0, this.element.scrollTop - this.headerHeight);
		const first = Math.max(0, Math.floor(top / this.rowHeight) - OVERSCAN);
		const last = Math.min(count, Math.ceil((top + this.element.clientHeight) / this.rowHeight) + OVERSCAN);
		if (!force && first === this.rendered.first && last === this.rendered.last) {
			return;
		}
		this.rendered = { first, last };
		const range = this.range();
		const focus = this.selection?.focus;
		const fragment = document.createDocumentFragment();
		for (let row = first; row < last; row++) {
			fragment.append(this.renderRow(row, range, focus));
		}
		this.body.replaceChildren(fragment);
	}

	private renderRow(row: number, range: Range | undefined, focus: Cell | undefined): HTMLElement {
		const node = el('div', `row ${this.edits.state(row)}`);
		node.style.top = `${row * this.rowHeight}px`;
		const rowSelected = !!range && row >= range.top && row <= range.bottom;
		const gutter = el('div', rowSelected ? 'gutter selected' : 'gutter');
		gutter.style.width = `${this.gutter}px`;
		gutter.textContent = String(this.offset + row + 1);
		node.append(gutter);
		this.columns.forEach((column, col) => {
			const { text, muted } = display(this.edits.value(row, col), column);
			const cell = el('div', 'cell');
			cell.style.width = `${this.widths[col]}px`;
			cell.textContent = text;
			if (muted) {
				cell.classList.add('muted');
			} else if (column.numeric) {
				cell.classList.add('numeric');
			}
			if (this.edits.isModified(row, col)) {
				cell.classList.add('modified');
			}
			if (this.edits.isExpression(row, col)) {
				cell.classList.add('expression');
				cell.classList.remove('muted', 'numeric');
			}
			if (rowSelected && range && col >= range.left && col <= range.right) {
				cell.classList.add('selected');
			}
			if (focus && focus.row === row && focus.col === col) {
				cell.classList.add('focused');
			}
			if (this.matchKeys.has(`${row}:${col}`)) {
				cell.classList.add('match');
			}
			node.append(cell);
		});
		return node;
	}

	private range(): Range | undefined {
		const selection = this.selection;
		if (!selection || !this.edits.rowCount || !this.columns.length) {
			return undefined;
		}
		const { anchor, focus } = selection;
		return {
			top: selection.cols ? 0 : Math.min(anchor.row, focus.row),
			bottom: selection.cols ? this.edits.rowCount - 1 : Math.max(anchor.row, focus.row),
			left: selection.rows ? 0 : Math.min(anchor.col, focus.col),
			right: selection.rows ? this.columns.length - 1 : Math.max(anchor.col, focus.col),
		};
	}

	private columnAt(x: number): number {
		let left = 0;
		for (let col = 0; col < this.widths.length; col++) {
			left += this.widths[col];
			if (x < left) {
				return col;
			}
		}
		return this.widths.length - 1;
	}

	private columnLeft(col: number): number {
		return this.widths.slice(0, col).reduce((a, b) => a + b, 0);
	}

	private hit(e: MouseEvent): { cell: Cell; gutter: boolean } {
		const box = this.element.getBoundingClientRect();
		const x = e.clientX - box.left;
		const y = e.clientY - box.top + this.element.scrollTop - this.headerHeight;
		const row = Math.min(Math.max(Math.floor(y / this.rowHeight), 0), Math.max(this.edits.rowCount - 1, 0));
		const col = this.columnAt(Math.max(x + this.element.scrollLeft - this.gutter, 0));
		return { cell: { row, col }, gutter: x < this.gutter };
	}

	private bodyMousedown(e: MouseEvent): void {
		if (e.button === 2 && this.edits.rowCount) {
			this.commitEdit();
			const { cell, gutter } = this.hit(e);
			const range = this.range();
			const inside = range && cell.row >= range.top && cell.row <= range.bottom && (gutter || (cell.col >= range.left && cell.col <= range.right));
			if (!inside) {
				this.selection = { anchor: cell, focus: { ...cell }, rows: gutter, cols: false };
				this.renderAll();
				this.onSelect();
			}
			this.element.focus();
			this.onContext(this.selection?.focus);
			return;
		}
		if (e.button !== 0 || !this.edits.rowCount) {
			return;
		}
		e.preventDefault();
		this.commitEdit();
		this.element.focus();
		const { cell, gutter } = this.hit(e);
		const rows = gutter;
		if (e.shiftKey && this.selection) {
			this.selection.focus = cell;
		} else {
			this.selection = { anchor: cell, focus: { ...cell }, rows, cols: false };
		}
		this.renderAll();
		this.onSelect();
		if (e.detail === 2 && !gutter && !e.shiftKey) {
			this.edit();
			return;
		}
		const move = (ev: MouseEvent): void => {
			if (!this.selection) {
				return;
			}
			const target = this.hit(ev).cell;
			if (target.row !== this.selection.focus.row || target.col !== this.selection.focus.col) {
				this.selection.focus = target;
				this.reveal(target);
				this.renderAll();
				this.onSelect();
			}
		};
		const up = (): void => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}

	private headerMousedown(e: MouseEvent): void {
		if (e.button !== 0) {
			return;
		}
		const target = e.target as HTMLElement;
		const th = target.closest('.th');
		e.preventDefault();
		this.commitEdit();
		this.element.focus();
		if (!th) {
			if (target.closest('.corner') && this.edits.rowCount) {
				this.selection = { anchor: { row: 0, col: 0 }, focus: { row: this.edits.rowCount - 1, col: this.columns.length - 1 }, rows: true, cols: true };
				this.renderAll();
				this.onSelect();
			}
			return;
		}
		const col = [...this.header.children].indexOf(th) - 1;
		if (target.closest('.resizer')) {
			this.resize(e, col);
		} else if (target.closest('.th-sort')) {
			this.toggleSort(col, e.shiftKey || e.metaKey || e.ctrlKey);
		} else if (this.edits.rowCount) {
			const anchor = e.shiftKey && this.selection?.cols ? this.selection.anchor : { row: 0, col };
			this.selection = { anchor, focus: { row: this.edits.rowCount - 1, col }, rows: false, cols: true };
			this.renderAll();
			this.onSelect();
		}
	}

	private resize(e: MouseEvent, col: number): void {
		const start = e.clientX;
		const width = this.widths[col];
		const move = (ev: MouseEvent): void => {
			this.widths[col] = Math.max(40, width + ev.clientX - start);
			this.renderAll();
		};
		const up = (): void => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}

	private toggleSort(col: number, append: boolean): void {
		const name = this.columns[col].name;
		const current = this.sort.find(s => s.column === name);
		const next: SortKey | undefined = !current ? { column: name, desc: false } : !current.desc ? { column: name, desc: true } : undefined;
		const others = append ? this.sort.filter(s => s.column !== name) : [];
		const sort = next ? (append && current ? this.sort.map(s => s.column === name ? next : s) : [...others, next]) : others;
		this.onSort(sort);
	}

	private keydown(e: KeyboardEvent): void {
		if (this.editing || !this.columns.length) {
			return;
		}
		const mod = e.metaKey || e.ctrlKey;
		const page = Math.max(1, Math.floor((this.element.clientHeight - this.headerHeight) / this.rowHeight) - 1);
		const lastRow = this.edits.rowCount - 1;
		const lastCol = this.columns.length - 1;
		const focus = this.selection?.focus ?? { row: 0, col: 0 };
		let target: Cell | undefined;
		switch (e.key) {
			case 'ArrowUp':
				target = { row: mod ? 0 : focus.row - 1, col: focus.col };
				break;
			case 'ArrowDown':
				target = { row: mod ? lastRow : focus.row + 1, col: focus.col };
				break;
			case 'ArrowLeft':
				target = { row: focus.row, col: mod ? 0 : focus.col - 1 };
				break;
			case 'ArrowRight':
				target = { row: focus.row, col: mod ? lastCol : focus.col + 1 };
				break;
			case 'PageUp':
				target = { row: focus.row - page, col: focus.col };
				break;
			case 'PageDown':
				target = { row: focus.row + page, col: focus.col };
				break;
			case 'Home':
				target = mod ? { row: 0, col: focus.col } : { row: focus.row, col: 0 };
				break;
			case 'End':
				target = mod ? { row: lastRow, col: focus.col } : { row: focus.row, col: lastCol };
				break;
			case 'Tab':
				target = { row: focus.row, col: focus.col + (e.shiftKey ? -1 : 1) };
				break;
			case 'Enter':
			case 'F2':
				if (!mod) {
					e.preventDefault();
					this.edit();
				}
				return;
			case 'a':
				if (mod && lastRow >= 0) {
					e.preventDefault();
					e.stopPropagation();
					this.selection = { anchor: { row: 0, col: 0 }, focus: { row: lastRow, col: lastCol }, rows: true, cols: true };
					this.renderAll();
					this.onSelect();
				}
				return;
			default:
				if (e.key.length === 1 && !mod && !e.altKey && this.selection) {
					e.preventDefault();
					this.edit(e.key);
				}
				return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (lastRow < 0) {
			return;
		}
		target = { row: Math.min(Math.max(target.row, 0), lastRow), col: Math.min(Math.max(target.col, 0), lastCol) };
		const extend = e.shiftKey && e.key !== 'Tab' && this.selection;
		this.selection = extend && this.selection
			? { ...this.selection, focus: target }
			: { anchor: target, focus: { ...target }, rows: false, cols: false };
		this.reveal(target);
		this.renderAll();
		this.onSelect();
	}

	private reveal(cell: Cell): void {
		const top = cell.row * this.rowHeight;
		const viewTop = this.element.scrollTop;
		const viewHeight = this.element.clientHeight - this.headerHeight;
		if (top < viewTop) {
			this.element.scrollTop = top;
		} else if (top + this.rowHeight > viewTop + viewHeight) {
			this.element.scrollTop = top + this.rowHeight - viewHeight;
		}
		const left = this.columnLeft(cell.col);
		const right = left + this.widths[cell.col];
		const viewLeft = this.element.scrollLeft;
		const viewWidth = this.element.clientWidth - this.gutter;
		if (left < viewLeft) {
			this.element.scrollLeft = left;
		} else if (right > viewLeft + viewWidth) {
			this.element.scrollLeft = Math.min(left, right - viewWidth);
		}
	}

	private edit(initial?: string): void {
		const focus = this.selection?.focus;
		if (this.readOnly || !focus || this.edits.state(focus.row) === 'removed') {
			return;
		}
		const cell = { ...focus };
		this.selection = { anchor: { ...cell }, focus: cell, rows: false, cols: false };
		this.reveal(cell);
		this.renderAll();
		const value = this.edits.value(cell.row, cell.col);
		const text = value === null || value === undefined ? '' : String(value);
		const input = el('input', 'cell-editor');
		input.value = initial ?? text;
		input.spellcheck = false;
		this.editing = { input, cell, initial: text };
		this.placeEditor(input, cell);
		this.canvas.append(input);
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		input.addEventListener('keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.commitEdit();
				this.element.focus();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.cancelEdit();
				this.element.focus();
			} else if (e.key === 'Tab') {
				e.preventDefault();
				this.commitEdit();
				this.element.focus();
				this.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: e.shiftKey }));
			} else if (e.key === 'Enter') {
				this.commitEdit();
				this.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: e.metaKey, ctrlKey: e.ctrlKey, bubbles: true }));
			}
		});
		input.addEventListener('blur', () => {
			if (this.editing?.input === input) {
				this.commitEdit();
			}
		});
	}

	private placeEditor(input: HTMLInputElement, cell: Cell): void {
		input.style.left = `${this.gutter + this.columnLeft(cell.col)}px`;
		input.style.top = `${this.headerHeight + cell.row * this.rowHeight}px`;
		input.style.width = `${this.widths[cell.col]}px`;
	}

	private copy(e: ClipboardEvent): void {
		const data = this.selectionData();
		if (document.activeElement !== this.element || !data || !e.clipboardData) {
			return;
		}
		e.clipboardData.setData('text/plain', this.copyText(data.columns, data.rows));
		e.preventDefault();
	}
}
