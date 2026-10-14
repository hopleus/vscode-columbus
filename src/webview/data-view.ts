import { Edits } from '../shared/edits';
import { tokenize } from '../shared/sql-assist';
import { EXTRACTORS, extract } from '../shared/extract';
import type { ExtractorId } from '../shared/extract';
import { QUOTES, formatOrder, parseOrder, quoteIdentifier, sqlLiteral } from '../shared/format';
import type { Flavor, SortKey } from '../shared/format';
import type { GridColumn, HostMessage, Value, ViewMessage, ViewOptions } from '../shared/protocol';
import { addCondition, filterCondition } from '../shared/filters';
import type { FilterKind } from '../shared/filters';
import { searchPattern } from '../shared/search';
import type { SearchOptions } from '../shared/search';
import { Grid } from './grid';
import { icons } from './icons';
import { SqlInput } from './sql-input';

type WithoutId<T> = T extends unknown ? Omit<T, 'requestId'> : never;

export type Reply = Exclude<HostMessage, { type: 'init' }>;
export type RequestBody = WithoutId<Exclude<ViewMessage, { type: 'ready' }>>;

export type DataViewOptions = ViewOptions;

export interface DataViewHost {
	send(body: RequestBody): Promise<Reply>;
	extractor(): ExtractorId | undefined;
	saveExtractor(id: ExtractorId): void;
}

export interface DataSetup {
	columns: GridColumn[];
	readOnly: boolean;
	flavor: Flavor;
	table: string;
	pageSize: number;
	panel: string;
	where?: string;
	sql?: string;
	badge?: string;
}

type Side = 'value' | 'record' | 'aggregate';

export interface DataPage {
	rows: Value[][];
	offset: number;
	more: boolean;
	total: number | undefined;
}

const mac = navigator.userAgent.includes('Mac');
const PAGE_SIZES = [100, 200, 500, 1000];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}

export function shortcut(keys: string): string {
	return mac ? keys : keys.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+').replace('⇧', 'Shift+').replace('⌫', 'Backspace').replace('↩', 'Enter');
}

function action(svg: string, title: string, run: () => void, className = ''): HTMLButtonElement {
	const button = el('button', `action ${className}`.trim());
	button.innerHTML = svg;
	button.title = title;
	button.addEventListener('click', run);
	return button;
}

function textAction(title: string, run: (button: HTMLButtonElement) => void, dropdown = false): HTMLButtonElement {
	const button = el('button', dropdown ? 'action text dropdown' : 'action text');
	button.title = title;
	button.addEventListener('click', () => run(button));
	return button;
}

function setLabel(button: HTMLButtonElement, label: string): void {
	button.replaceChildren(label);
	if (button.classList.contains('dropdown')) {
		button.insertAdjacentHTML('beforeend', icons.chevronDown);
	}
}

function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function separator(): HTMLElement {
	return el('span', 'separator');
}

export class DataView {
	readonly root = el('div', 'data-view');
	readonly grid = new Grid();

	private columns: GridColumn[] = [];
	private readOnly = true;
	private flavor: Flavor = 'postgres';
	private table = '';
	private pageSize = 500;
	private offset = 0;
	private total: number | undefined;
	private more = false;
	private lastWhere = '';
	private edits = new Edits([]);
	private loadId = 0;
	private busy = false;
	private manual = false;
	private transaction = false;
	private extractor: ExtractorId;
	private readonly searchOptions: SearchOptions = { matchCase: false, words: false, regex: false };

	private readonly reload = action(icons.refresh, `Reload Page (${shortcut('⌘R')})`, () => void this.load(this.offset));
	private readonly stop = action(icons.stop, `Cancel Running Statement (${shortcut('⌘F2')})`, () => void this.simple({ type: 'cancel' }), 'stop');
	private readonly add = action(icons.add, `Add Row (${shortcut('⌘N')})`, () => this.addRow());
	private readonly remove = action(icons.remove, `Delete Rows (${shortcut('⌘⌫')})`, () => this.removeRows());
	private readonly revert = action(icons.revert, `Revert Selected (${shortcut('⌥⌘Z')})`, () => this.revertRows());
	private readonly preview = action(icons.preview, 'Preview Pending Changes', () => void this.previewChanges());
	private readonly submit = action(icons.submit, `Submit (${shortcut('⌘↩')})`, () => void this.submitChanges(), 'submit');
	private readonly mode = textAction('Transaction Mode', button => this.openMenu(button, [
		this.menuItem('Auto', !this.manual, () => void this.setMode(false)),
		this.menuItem('Manual', this.manual, () => void this.setMode(true)),
	]), true);
	private readonly commit = action(icons.commit, 'Commit', () => void this.finish('commit'), 'commit');
	private readonly rollback = action(icons.revert, 'Rollback', () => void this.finish('rollback'), 'rollback');
	private readonly ddl = textAction('Show DDL', () => void this.simple({ type: 'ddl' }));
	private readonly find = action(icons.search, `Find (${shortcut('⌘F')})`, () => this.openFind());
	private readonly format = textAction('Data Extractor', button => this.openMenu(button, (Object.keys(EXTRACTORS) as ExtractorId[]).map(id =>
		this.menuItem(EXTRACTORS[id].label, id === this.extractor, () => {
			this.extractor = id;
			this.host.saveExtractor(id);
			this.update();
		})
	)), true);
	private readonly exporter = action(icons.download, 'Export Data', () => this.exportData(false));
	private readonly sqlButton = textAction('Show the Query of This Result', button => this.showSql(button));
	private readonly badge = textAction('Time to Live: click to change', () => void this.simple({ type: 'badge' }));
	private readonly openTab = action(icons.openInTab, 'Open in Editor Tab', () => void this.simple({ type: 'openInTab' }));
	private readonly sideToggle = action(icons.sidePanel, `Show Value Editor (${shortcut('⇧↩')})`, () => this.toggleSide());
	private sql = '';
	private readonly where = new SqlInput('where', 'WHERE', icons.filter);
	private readonly orderBy = new SqlInput('order', 'ORDER BY', icons.order);
	private readonly message = el('div', 'message');
	private readonly main = el('div', 'main');
	private readonly finder = el('div', 'find');
	private readonly findInput = el('input');
	private readonly findCount = el('span', 'find-count');
	private readonly toggles: { option: keyof SearchOptions; toggle: HTMLButtonElement }[];
	private readonly previous = action(icons.chevronLeft, 'Previous Page', () => void this.load(Math.max(0, this.offset - this.pageSize)));
	private readonly next = action(icons.chevronRight, 'Next Page', () => void this.load(this.offset + this.pageSize));
	private readonly size = el('button', 'pager-size');
	private readonly menu = el('div', 'menu');
	private readonly filters = el('div', 'filters');
	private readonly side = el('div', 'side-panel');
	private sideKind: Side | undefined;
	private panel = '';

	constructor(private readonly host: DataViewHost, private readonly options: DataViewOptions) {
		this.extractor = host.extractor() ?? 'csv';
		setLabel(this.ddl, 'DDL');
		setLabel(this.sqlButton, 'SQL');

		const toolbar = el('div', 'toolbar');
		toolbar.append(this.reload, this.stop);
		if (options.editable) {
			toolbar.append(separator(), this.add, this.remove, this.revert, this.preview, this.submit);
		}
		if (options.transactions) {
			toolbar.append(separator(), this.mode, this.commit, this.rollback);
		}
		toolbar.append(el('span', 'spacer'), this.badge);
		this.badge.hidden = true;
		if (options.sql) {
			toolbar.append(this.sqlButton);
		}
		if (options.openInTab) {
			toolbar.append(this.openTab);
		}
		if (options.ddl) {
			toolbar.append(this.ddl);
		}
		toolbar.append(this.find, separator(), this.format, this.exporter, separator(), this.sideToggle);

		this.filters.append(this.where.root, this.orderBy.root);
		this.filters.hidden = !options.filters;

		this.findInput.placeholder = 'Find';
		this.findInput.spellcheck = false;
		const findField = el('div', 'find-field');
		this.toggles = ([['matchCase', 'Cc', 'Match Case (⌥C)'], ['words', 'W', 'Words (⌥W)'], ['regex', '.*', 'Regex (⌥X)']] as const).map(([option, label, title]) => {
			const toggle = el('button', 'find-toggle');
			toggle.textContent = label;
			toggle.title = shortcut(title);
			toggle.addEventListener('mousedown', e => e.preventDefault());
			toggle.addEventListener('click', () => this.toggleOption(option));
			return { option, toggle };
		});
		findField.append(this.findInput, ...this.toggles.map(t => t.toggle));
		this.finder.append(
			findField,
			this.findCount,
			action(icons.arrowUp, 'Previous Match (⇧↩)', () => this.grid.step(-1)),
			action(icons.arrowDown, 'Next Match (↩)', () => this.grid.step(1)),
			action(icons.close, 'Close (Escape)', () => this.closeFind())
		);
		this.main.append(this.grid.element, el('div', 'progress'), this.finder, this.side);
		this.side.hidden = true;

		const pager = el('div', 'pager');
		this.size.addEventListener('click', () => this.openPageMenu());
		pager.append(this.previous, this.size, this.next);
		this.root.append(toolbar, this.filters, this.message, this.main, pager, this.menu);

		this.bind();
		this.update();
	}

	setup(setup: DataSetup): void {
		this.columns = setup.columns;
		this.readOnly = setup.readOnly || !this.options.editable;
		this.flavor = setup.flavor;
		this.table = setup.table;
		this.pageSize = setup.pageSize;
		this.offset = 0;
		this.total = undefined;
		this.more = false;
		this.lastWhere = '';
		this.edits = new Edits([]);
		this.panel = setup.panel;
		this.sql = setup.sql ?? '';
		this.setBadge(setup.badge);
		this.where.value = setup.where ?? '';
		this.orderBy.value = '';
		this.filters.hidden = !this.options.filters && !this.where.value;
		this.closeSide();
		this.where.setContext(this.columns, this.flavor);
		this.orderBy.setContext(this.columns, this.flavor);
		this.grid.setColumns(this.columns, this.readOnly);
		this.grid.setSort([]);
		this.showError(undefined);
	}

	show(page: DataPage): void {
		this.offset = page.offset;
		this.more = page.more;
		this.total = page.total;
		this.edits = new Edits(page.rows);
		this.grid.setRows(this.edits, this.offset);
		this.update();
	}

	async load(start: number): Promise<void> {
		this.grid.commitEdit();
		if (!await this.confirmDiscard()) {
			return;
		}
		const id = ++this.loadId;
		this.busy = true;
		this.update();
		const where = this.where.value;
		const reply = await this.host.send({ type: 'load', where, orderBy: this.orderBy.value, offset: start, limit: this.pageSize });
		if (id !== this.loadId) {
			return;
		}
		this.busy = false;
		if (reply.type === 'rows') {
			this.showError(undefined);
			const total = reply.total ?? (where === this.lastWhere ? this.total : undefined);
			this.lastWhere = where;
			this.show({ rows: reply.rows, offset: reply.offset, more: reply.more, total });
		} else if (reply.type === 'failed') {
			this.showError(reply.message);
		}
		this.update();
	}

	focus(): void {
		this.grid.element.focus();
	}

	setBadge(text: string | undefined): void {
		this.badge.hidden = !text;
		this.badge.textContent = text ?? '';
	}

	disconnected(): void {
		if (this.transaction) {
			this.transaction = false;
			this.update();
		}
	}

	applyFilter(where: string): void {
		this.where.value = where;
		this.filters.hidden = !this.options.filters && !where;
		void this.load(0);
	}

	run(action: string): void {
		const separator = action.indexOf(':');
		const name = separator < 0 ? action : action.slice(0, separator);
		const argument = separator < 0 ? undefined : action.slice(separator + 1);
		switch (name) {
			case 'setExpression':
				if (argument) {
					this.setExpression(argument);
				}
				return;
			case 'setDefault':
				this.setExpression('DEFAULT');
				return;
			case 'reload':
				void this.load(this.offset);
				return;
			case 'edit':
				this.grid.startEdit();
				return;
			case 'valueEditor':
				this.openSide('value');
				return;
			case 'setNull':
				this.setNull();
				return;
			case 'revert':
				this.revertRows();
				return;
			case 'copy':
				void this.copyAs((argument as ExtractorId | undefined) ?? this.extractor);
				return;
			case 'paste':
				void this.paste();
				return;
			case 'addRow':
				this.addRow();
				return;
			case 'cloneRow':
				this.cloneRows();
				return;
			case 'deleteRows':
				this.removeRows();
				return;
			case 'filter':
				this.filterBy(argument);
				return;
			case 'clearFilter':
				this.applyFilter('');
				return;
			case 'goTo':
				void this.goToReference();
				return;
			case 'recordView':
				this.openSide('record');
				return;
			case 'aggregate':
				this.openSide('aggregate');
				return;
			case 'exportClipboard':
				this.exportData(true);
				return;
		}
	}

	private bind(): void {
		this.grid.onEdit = () => {
			this.update();
			this.renderSide();
		};
		this.grid.onSelect = () => {
			this.update();
			this.renderSide();
		};
		this.grid.onContext = () => this.updateContext();
		this.grid.onSort = sort => this.sortBy(sort);
		this.grid.onMatches = (index, count) => {
			const query = this.findInput.value;
			this.findCount.textContent = !query ? '' : index ? `${index}/${count}` : `${count} result${count === 1 ? '' : 's'}`;
			this.finder.classList.toggle('empty', !!query && !count && !this.finder.classList.contains('invalid'));
		};
		this.grid.copyText = (selected, rows) => extract(this.extractor, { columns: selected.map(c => c.name), table: this.table, flavor: this.flavor }, rows, false);

		this.findInput.addEventListener('input', () => this.runSearch());
		this.findInput.addEventListener('keydown', e => {
			const option = e.altKey ? ({ KeyC: 'matchCase', KeyW: 'words', KeyX: 'regex' } as const)[e.code as 'KeyC' | 'KeyW' | 'KeyX'] : undefined;
			if (option) {
				e.preventDefault();
				this.toggleOption(option);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				this.grid.step(e.shiftKey ? -1 : 1);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.closeFind();
			}
		});

		for (const input of [this.where.input, this.orderBy.input]) {
			input.addEventListener('keydown', e => {
				if (e.key === 'Enter') {
					e.preventDefault();
					this.grid.setSort(parseOrder(this.orderBy.value));
					void this.load(0);
				} else if (e.key === 'Escape') {
					this.focus();
				}
			});
		}

		document.addEventListener('mousedown', e => {
			if (!(e.target as HTMLElement).closest('.menu, .dropdown, .pager-size')) {
				this.closeMenu();
			}
		});

		document.addEventListener('paste', e => {
			const text = e.clipboardData?.getData('text/plain');
			if (!this.root.isConnected || this.root.hidden || document.activeElement !== this.grid.element || text === undefined) {
				return;
			}
			e.preventDefault();
			this.pasteText(text);
		});

		document.addEventListener('keydown', e => {
			if (!this.root.isConnected || this.root.hidden) {
				return;
			}
			const mod = e.metaKey || e.ctrlKey;
			const handled = (run: () => void): void => {
				e.preventDefault();
				e.stopPropagation();
				run();
			};
			const inGrid = document.activeElement === this.grid.element;
			if (e.key === 'Escape' && this.menu.classList.contains('visible')) {
				handled(() => this.closeMenu());
			} else if (e.key === 'F2' && mod && this.busy) {
				handled(() => void this.simple({ type: 'cancel' }));
			} else if (e.key === 'F3') {
				handled(() => this.grid.step(e.shiftKey ? -1 : 1));
			} else if (e.key === 'Escape' && this.sideKind && !mod) {
				handled(() => this.closeSide());
			} else if (e.key === 'Enter' && e.shiftKey && !mod && inGrid) {
				handled(() => this.openSide('value'));
			} else if (!mod) {
				return;
			} else if (e.key === 'Enter' && e.shiftKey) {
				handled(() => this.openSide('record'));
			} else if (e.key === 'd' && inGrid && this.options.editable) {
				handled(() => this.cloneRows());
			} else if (e.key === 'Enter' && this.options.editable) {
				handled(() => void this.submitChanges());
			} else if (e.key === 'f') {
				handled(() => this.openFind());
			} else if (e.key === 'r' && !e.shiftKey) {
				handled(() => void this.load(this.offset));
			} else if (e.key === 'n' && inGrid && this.options.editable) {
				handled(() => this.addRow());
			} else if (e.key === 'Backspace' && inGrid && this.options.editable) {
				handled(() => this.removeRows());
			} else if (e.key === 'z' && e.altKey && inGrid && this.options.editable) {
				handled(() => this.revertRows());
			}
		});
	}

	private updateContext(): void {
		const cell = this.grid.focused();
		const column = cell ? this.columns[cell.col] : undefined;
		const value = cell ? this.edits.value(cell.row, cell.col) : undefined;
		this.grid.element.dataset.vscodeContext = JSON.stringify({
			webviewSection: 'columbus.cell',
			preventDefaultContextMenuItems: true,
			columbusPanel: this.panel,
			editable: !this.readOnly && !!cell && this.edits.state(cell.row) !== 'removed',
			expressions: !this.readOnly && !!this.options.expressions && !!cell && this.edits.state(cell.row) !== 'removed',
			defaults: !this.readOnly && !!this.options.expressions && this.flavor !== 'sqlite' && !!cell && this.edits.state(cell.row) !== 'removed',
			reference: !!column?.references && value !== null && value !== undefined,
			filtered: !!this.where.value.trim(),
		});
	}

	private literal(value: Value): string {
		return sqlLiteral(value, this.flavor);
	}

	private async copyAs(format: ExtractorId): Promise<void> {
		const data = this.grid.selectionData();
		if (data) {
			await this.simple({ type: 'clipboard', text: extract(format, { columns: data.columns.map(c => c.name), table: this.table, flavor: this.flavor }, data.rows, false) });
		}
	}

	private async paste(): Promise<void> {
		if (this.readOnly || !this.grid.focused()) {
			return;
		}
		const reply = await this.host.send({ type: 'readClipboard' });
		if (reply.type === 'text' && reply.text) {
			this.pasteText(reply.text);
		}
	}

	private pasteText(text: string): void {
		const focus = this.grid.focused();
		const range = this.grid.selectedRange();
		if (this.readOnly || !focus || !text) {
			return;
		}
		const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).map(line => line.split('\t'));
		if (lines.length === 1 && lines[0].length === 1 && range && (range.bottom > range.top || range.right > range.left)) {
			for (let row = range.top; row <= range.bottom; row++) {
				for (let col = range.left; col <= range.right; col++) {
					if (this.edits.state(row) !== 'removed') {
						const original = this.edits.original(row, col);
						this.edits.set(row, col, original !== undefined && original !== null && String(original) === lines[0][0] ? original : lines[0][0]);
					}
				}
			}
			this.grid.refresh();
			this.update();
			return;
		}
		lines.forEach((cells, i) => {
			const row = focus.row + i;
			while (row >= this.edits.rowCount) {
				this.edits.add();
			}
			cells.forEach((text, j) => {
				const col = focus.col + j;
				if (col < this.columns.length && this.edits.state(row) !== 'removed') {
					const original = this.edits.original(row, col);
					this.edits.set(row, col, original !== undefined && original !== null && String(original) === text ? original : text);
				}
			});
		});
		this.grid.refresh();
		this.update();
	}

	private setExpression(sql: string): void {
		const range = this.grid.selectedRange();
		if (this.readOnly || !range || !this.options.expressions) {
			return;
		}
		for (let row = range.top; row <= range.bottom; row++) {
			for (let col = range.left; col <= range.right; col++) {
				if (this.edits.state(row) !== 'removed') {
					this.edits.setExpression(row, col, sql);
				}
			}
		}
		this.grid.refresh();
		this.update();
	}

	private setNull(): void {
		const range = this.grid.selectedRange();
		if (this.readOnly || !range) {
			return;
		}
		for (let row = range.top; row <= range.bottom; row++) {
			for (let col = range.left; col <= range.right; col++) {
				if (this.edits.state(row) !== 'removed') {
					this.edits.set(row, col, null);
				}
			}
		}
		this.grid.refresh();
		this.update();
	}

	private cloneRows(): void {
		const rows = this.grid.selectedRows();
		if (this.readOnly || !rows.length) {
			return;
		}
		this.grid.commitEdit();
		let last = -1;
		for (const source of rows) {
			last = this.edits.add();
			this.columns.forEach((column, col) => {
				const value = this.edits.value(source, col);
				if (!column.generated && value !== undefined) {
					this.edits.set(last, col, value);
				}
			});
		}
		this.grid.focusCell(last, Math.max(0, this.columns.findIndex(c => !c.generated)));
		this.update();
	}

	private filterBy(kind: string | undefined): void {
		const cell = this.grid.focused();
		if (!cell || !kind) {
			return;
		}
		const value = this.edits.value(cell.row, cell.col) ?? null;
		this.applyFilter(addCondition(this.where.value, filterCondition(kind as FilterKind, this.columns[cell.col].name, value, this.flavor)));
	}

	private async goToReference(): Promise<void> {
		const cell = this.grid.focused();
		const reference = cell ? this.columns[cell.col].references : undefined;
		const value = cell ? this.edits.value(cell.row, cell.col) : undefined;
		if (!reference || value === null || value === undefined) {
			return;
		}
		await this.simple({
			type: 'navigate',
			schema: reference.schema,
			table: reference.table,
			where: `${quoteIdentifier(reference.column, QUOTES[this.flavor])} = ${this.literal(value)}`,
		});
	}

	private exportData(clipboard: boolean): void {
		void this.simple({ type: 'export', format: this.extractor, where: this.where.value, orderBy: this.orderBy.value, clipboard });
	}

	private openSide(kind: Side): void {
		if (!this.grid.focused()) {
			return;
		}
		this.sideKind = kind;
		this.side.hidden = false;
		this.sideToggle.classList.toggle('active', kind === 'value');
		this.renderSide();
		this.side.querySelector<HTMLElement>('textarea, button')?.focus();
	}

	private closeSide(): void {
		this.sideKind = undefined;
		this.side.hidden = true;
		this.side.replaceChildren();
		this.sideToggle.classList.remove('active');
	}

	private toggleSide(): void {
		if (this.sideKind) {
			this.closeSide();
			this.focus();
			return;
		}
		if (!this.grid.focused() && this.edits.rowCount) {
			this.grid.focusCell(0, 0);
		}
		this.openSide('value');
	}

	private showSql(button: HTMLButtonElement): void {
		const box = el('div', 'sql-preview');
		const header = el('div', 'sql-preview-header');
		const title = el('span', 'sql-preview-title');
		title.textContent = 'Query';
		const run = (body: RequestBody) => (): void => {
			this.closeMenu();
			void this.simple(body);
		};
		header.append(
			title,
			action(icons.copy, 'Copy', run({ type: 'clipboard', text: this.sql })),
			action(icons.console, 'Open in Query Console', run({ type: 'query', action: 'console' })),
			action(icons.locate, 'Locate in Query Console', run({ type: 'query', action: 'locate' }))
		);
		const code = el('pre');
		for (const token of tokenize(this.sql, this.flavor, this.columns.map(c => c.name))) {
			const span = el('span', token.kind === 'space' || token.kind === 'operator' || token.kind === 'identifier' ? '' : `tk-${token.kind}`);
			span.textContent = token.text;
			code.append(span);
		}
		box.append(header, code);
		this.openMenu(button, [box]);
	}

	private sideHeader(title: string, ...extra: HTMLElement[]): HTMLElement {
		const header = el('div', 'side-header');
		const caption = el('span', 'side-title');
		caption.textContent = title;
		header.append(caption, ...extra, action(icons.close, 'Close (Escape)', () => {
			this.closeSide();
			this.focus();
		}));
		return header;
	}

	private renderSide(): void {
		const cell = this.grid.focused();
		if (!this.sideKind || !cell) {
			return;
		}
		if (this.sideKind === 'value') {
			if (this.side.dataset.cell === `${cell.row}:${cell.col}` && this.side.querySelector('textarea')) {
				return;
			}
			this.side.dataset.cell = `${cell.row}:${cell.col}`;
			this.renderValueEditor(cell.row, cell.col);
		} else if (this.sideKind === 'record') {
			this.renderRecord(cell.row);
		} else {
			this.renderAggregate();
		}
	}

	private renderValueEditor(row: number, col: number): void {
		const column = this.columns[col];
		const value = this.edits.value(row, col);
		const raw = value === null || value === undefined ? '' : String(value);
		const text = /^\s*[[{]/.test(raw) ? prettyJson(raw) : raw;
		const area = el('textarea', 'side-editor');
		area.value = text;
		area.spellcheck = false;
		area.readOnly = this.readOnly || this.edits.state(row) === 'removed';
		const apply = el('button', 'side-button primary');
		apply.textContent = 'Apply';
		apply.title = shortcut('⌘↩');
		apply.hidden = area.readOnly;
		const save = (): void => {
			if (!area.readOnly && area.value !== text) {
				const original = this.edits.original(row, col);
				this.grid.setValue(row, col, original !== undefined && original !== null && String(original) === area.value ? original : area.value);
			}
			this.closeSide();
			this.focus();
		};
		apply.addEventListener('click', save);
		area.addEventListener('keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				save();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.closeSide();
				this.focus();
			}
		});
		const footer = el('div', 'side-footer');
		const note = el('span', 'side-note');
		note.textContent = `${column.name} · ${column.type}`;
		footer.append(note, apply);
		this.side.replaceChildren(this.sideHeader('Value'), area, footer);
	}

	private renderRecord(row: number): void {
		const previous = action(icons.chevronLeft, 'Previous Record', () => this.grid.focusCell(Math.max(0, row - 1), this.grid.focused()?.col ?? 0));
		const next = action(icons.chevronRight, 'Next Record', () => this.grid.focusCell(Math.min(this.edits.rowCount - 1, row + 1), this.grid.focused()?.col ?? 0));
		previous.disabled = row === 0;
		next.disabled = row >= this.edits.rowCount - 1;
		const list = el('div', 'side-list');
		this.columns.forEach((column, col) => {
			const value = this.edits.value(row, col);
			const item = el('div', 'side-row');
			const name = el('span', 'side-name');
			name.textContent = column.name;
			name.title = column.type;
			const text = el('span', value === null || value === undefined ? 'side-value muted' : 'side-value');
			text.textContent = value === null ? '<null>' : value === undefined ? '<default>' : String(value);
			item.append(name, text);
			item.addEventListener('dblclick', () => this.grid.focusCell(row, col));
			list.append(item);
		});
		this.side.replaceChildren(this.sideHeader(`Record ${this.offset + row + 1}`, previous, next), list);
	}

	private renderAggregate(): void {
		const data = this.grid.selectionData();
		const values = (data?.rows.flat() ?? []).filter((v): v is Exclude<typeof v, null> => v !== null);
		const numbers = values.map(Number);
		const numeric = values.length > 0 && numbers.every(Number.isFinite);
		const sum = numbers.reduce((a, b) => a + b, 0);
		const round = (n: number): string => String(Math.round(n * 1e10) / 1e10);
		const texts = values.map(String).sort();
		const stats: [string, string][] = [
			['Count', String(data?.rows.flat().length ?? 0)],
			['Not null', String(values.length)],
			['Distinct', String(new Set(values.map(String)).size)],
		];
		if (numeric) {
			stats.push(['Sum', round(sum)], ['Avg', round(sum / numbers.length)], ['Min', round(Math.min(...numbers))], ['Max', round(Math.max(...numbers))]);
		} else if (texts.length) {
			stats.push(['Min', texts[0]], ['Max', texts[texts.length - 1]]);
		}
		const list = el('div', 'side-list');
		for (const [name, value] of stats) {
			const item = el('div', 'side-row clickable');
			const label = el('span', 'side-name');
			label.textContent = name;
			const text = el('span', 'side-value');
			text.textContent = value;
			item.title = 'Copy';
			item.append(label, text);
			item.addEventListener('click', () => void this.simple({ type: 'clipboard', text: value }));
			list.append(item);
		}
		this.side.replaceChildren(this.sideHeader('Aggregate'), list);
	}

	private update(): void {
		const rows = this.grid.selectedRows();
		this.add.disabled = this.readOnly;
		this.remove.disabled = this.readOnly || !rows.length;
		this.revert.disabled = !this.edits.dirty;
		this.preview.disabled = this.readOnly || !this.edits.dirty;
		this.submit.disabled = this.readOnly || !this.edits.dirty || this.busy;
		this.reload.disabled = this.busy;
		this.stop.disabled = !this.busy;
		setLabel(this.mode, `Tx: ${this.manual ? 'Manual' : 'Auto'}`);
		this.commit.hidden = !this.manual;
		this.rollback.hidden = !this.manual;
		this.commit.disabled = this.busy || !this.transaction;
		this.rollback.disabled = this.busy || !this.transaction;
		setLabel(this.format, EXTRACTORS[this.extractor].label);
		const loaded = this.edits.loadedCount;
		const from = this.offset + 1;
		const to = this.offset + loaded;
		const paged = this.offset > 0 || this.more;
		this.size.replaceChildren(paged ? `${from}–${to} of ${this.total ?? `${to}+`}` : `${loaded} row${loaded === 1 ? '' : 's'}`);
		this.size.insertAdjacentHTML('beforeend', icons.chevronDown);
		this.previous.hidden = !paged;
		this.next.hidden = !paged;
		this.previous.disabled = this.busy || this.offset === 0;
		this.next.disabled = this.busy || !this.more;
		this.main.classList.toggle('loading', this.busy);
	}

	private showError(text: string | undefined): void {
		this.message.textContent = text ?? '';
		this.message.classList.toggle('visible', !!text);
	}

	private async simple(body: RequestBody): Promise<void> {
		const reply = await this.host.send(body);
		if (reply.type === 'failed') {
			this.showError(reply.message);
		}
	}

	private async confirmDiscard(): Promise<boolean> {
		if (!this.edits.dirty) {
			return true;
		}
		const reply = await this.host.send({ type: 'confirm', message: 'Discard pending changes?', action: 'Discard' });
		return reply.type === 'confirmed' && reply.ok;
	}

	private sortBy(sort: SortKey[]): void {
		this.orderBy.value = formatOrder(sort, QUOTES[this.flavor]);
		this.grid.setSort(sort);
		void this.load(0);
	}

	private addRow(): void {
		if (this.readOnly) {
			return;
		}
		this.grid.commitEdit();
		const row = this.edits.add();
		const first = this.columns.findIndex(c => !c.generated);
		this.grid.focusCell(row, Math.max(first, 0));
		this.update();
	}

	private removeRows(): void {
		const rows = this.grid.selectedRows();
		if (this.readOnly || !rows.length) {
			return;
		}
		this.grid.commitEdit();
		this.edits.remove(rows);
		this.grid.refresh();
		this.update();
	}

	private revertRows(): void {
		this.grid.commitEdit();
		const rows = this.grid.selectedRows();
		if (rows.length) {
			this.edits.revert(rows);
		} else {
			this.edits.revertAll();
		}
		this.grid.refresh();
		this.update();
	}

	private async previewChanges(): Promise<void> {
		this.grid.commitEdit();
		if (this.edits.dirty) {
			await this.simple({ type: 'preview', changes: this.edits.changes(this.columns) });
		}
	}

	private async submitChanges(): Promise<void> {
		this.grid.commitEdit();
		if (this.readOnly || !this.edits.dirty || this.busy) {
			return;
		}
		this.busy = true;
		this.update();
		const reply = await this.host.send({ type: 'submit', changes: this.edits.changes(this.columns) });
		this.busy = false;
		if (reply.type === 'failed') {
			this.showError(reply.message);
			this.update();
			return;
		}
		if (reply.type === 'submitted') {
			this.transaction = reply.transaction;
		}
		this.edits.revertAll();
		await this.load(this.offset);
	}

	private async setMode(value: boolean): Promise<void> {
		const hadTransaction = this.transaction;
		const reply = await this.host.send({ type: 'mode', manual: value });
		if (reply.type === 'transaction') {
			this.manual = reply.manual;
			this.transaction = reply.active;
			this.update();
			if (hadTransaction && !this.transaction) {
				await this.load(this.offset);
			}
		} else if (reply.type === 'failed') {
			this.showError(reply.message);
		}
	}

	private async finish(type: 'commit' | 'rollback'): Promise<void> {
		this.busy = true;
		this.update();
		const reply = await this.host.send({ type });
		this.busy = false;
		if (reply.type === 'transaction') {
			this.transaction = reply.active;
			this.showError(undefined);
			if (type === 'rollback') {
				this.edits.revertAll();
				await this.load(this.offset);
				return;
			}
		} else if (reply.type === 'failed') {
			this.showError(reply.message);
		}
		this.update();
	}

	private async countRows(): Promise<void> {
		const where = this.where.value;
		this.busy = true;
		this.update();
		const reply = await this.host.send({ type: 'count', where });
		this.busy = false;
		if (reply.type === 'counted') {
			this.total = reply.total;
			this.lastWhere = where;
		} else if (reply.type === 'failed') {
			this.showError(reply.message);
		}
		this.update();
	}

	private menuItem(label: string, checked: boolean, run: () => void): HTMLButtonElement {
		const item = el('button', checked ? 'menu-item checked' : 'menu-item');
		item.textContent = label;
		item.addEventListener('click', () => {
			this.closeMenu();
			run();
		});
		return item;
	}

	private openMenu(anchor: HTMLElement, items: HTMLElement[], above = false): void {
		if (this.menu.classList.contains('visible') && this.menu.dataset.anchor === anchor.className) {
			this.closeMenu();
			return;
		}
		this.menu.replaceChildren(...items);
		this.menu.dataset.anchor = anchor.className;
		const box = anchor.getBoundingClientRect();
		this.menu.style.left = `${Math.max(4, box.left)}px`;
		this.menu.style.top = above ? '' : `${box.bottom + 4}px`;
		this.menu.style.bottom = above ? `${window.innerHeight - box.top + 4}px` : '';
		this.menu.style.maxHeight = `${Math.max(80, (above ? box.top : window.innerHeight - box.bottom) - 12)}px`;
		this.menu.classList.add('visible');
		const width = this.menu.offsetWidth;
		if (box.left + width > window.innerWidth - 4) {
			this.menu.style.left = `${Math.max(4, window.innerWidth - width - 4)}px`;
		}
	}

	private closeMenu(): void {
		this.menu.classList.remove('visible');
		delete this.menu.dataset.anchor;
	}

	private openPageMenu(): void {
		const items: HTMLElement[] = PAGE_SIZES.map(n => this.menuItem(`${n} rows`, n === this.pageSize, () => {
			this.pageSize = n;
			void this.load(0);
		}));
		if (this.total === undefined && (this.offset > 0 || this.more)) {
			items.push(el('div', 'menu-separator'), this.menuItem('Count Rows', false, () => void this.countRows()));
		}
		this.openMenu(this.size, items, true);
	}

	private openFind(): void {
		this.finder.classList.add('visible');
		this.findInput.focus();
		this.findInput.select();
		this.runSearch();
	}

	private runSearch(): void {
		let pattern: RegExp | undefined;
		try {
			pattern = searchPattern(this.findInput.value, this.searchOptions);
			this.finder.classList.remove('invalid');
		} catch {
			this.finder.classList.add('invalid');
		}
		this.grid.search(pattern);
	}

	private toggleOption(option: keyof SearchOptions): void {
		this.searchOptions[option] = !this.searchOptions[option];
		for (const { option: name, toggle } of this.toggles) {
			toggle.classList.toggle('on', this.searchOptions[name]);
		}
		this.findInput.focus();
		this.runSearch();
	}

	private closeFind(): void {
		this.finder.classList.remove('visible');
		this.grid.search(undefined);
		this.focus();
	}
}
