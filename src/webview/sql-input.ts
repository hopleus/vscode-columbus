import type { Flavor } from '../shared/format';
import type { GridColumn } from '../shared/protocol';
import { suggest, tokenize, wordAt } from '../shared/sql-assist';
import type { Clause, Suggestion } from '../shared/sql-assist';
import { icons } from './icons';

const PLAIN_TOKENS = new Set(['space', 'operator', 'identifier']);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}

function iconFor(suggestion: Suggestion): HTMLElement {
	const icon = el('span', `completion-icon ${suggestion.kind}`);
	if (suggestion.column) {
		icon.innerHTML = suggestion.column.primary ? icons.columnKey : suggestion.column.foreign ? icons.columnForeign : icons.column;
	} else {
		icon.textContent = suggestion.kind === 'function' ? 'ƒ' : 'k';
	}
	return icon;
}

export class SqlInput {
	readonly root = el('label', 'filter');
	readonly input = el('input');
	private readonly layer = el('div', 'sql-layer');
	private readonly popup = el('div', 'completion');
	private columns: GridColumn[] = [];
	private flavor: Flavor = 'postgres';
	private items: Suggestion[] = [];
	private active = 0;
	private word: { start: number; prefix: string } | undefined;

	constructor(private readonly clause: Clause, placeholder: string, svg: string) {
		const icon = el('span', 'filter-icon');
		icon.innerHTML = svg;
		const field = el('div', 'sql-field');
		this.input.placeholder = placeholder;
		this.input.spellcheck = false;
		this.input.autocomplete = 'off';
		field.append(this.layer, this.input);
		this.root.append(icon, field);
		document.body.append(this.popup);

		this.input.addEventListener('input', () => {
			this.render();
			this.complete(false);
		});
		this.input.addEventListener('keydown', e => this.keydown(e));
		this.input.addEventListener('scroll', () => this.sync());
		for (const type of ['click', 'select', 'focus']) {
			this.input.addEventListener(type, () => this.sync());
		}
		this.input.addEventListener('blur', () => this.hide());
		this.popup.addEventListener('mousedown', e => {
			e.preventDefault();
			const item = (e.target as HTMLElement).closest<HTMLElement>('.completion-item');
			if (item) {
				this.accept(Number(item.dataset.index));
			}
		});
	}

	get value(): string {
		return this.input.value;
	}

	set value(text: string) {
		this.input.value = text;
		this.render();
	}

	setContext(columns: GridColumn[], flavor: Flavor): void {
		this.columns = columns;
		this.flavor = flavor;
		this.render();
	}

	private render(): void {
		const fragment = document.createDocumentFragment();
		for (const token of tokenize(this.input.value, this.flavor, this.columns.map(c => c.name))) {
			if (PLAIN_TOKENS.has(token.kind)) {
				fragment.append(token.text);
			} else {
				const span = el('span', `tk-${token.kind}`);
				span.textContent = token.text;
				fragment.append(span);
			}
		}
		const text = el('span', 'sql-text');
		text.append(fragment);
		this.layer.replaceChildren(text);
		this.sync();
		requestAnimationFrame(() => this.sync());
	}

	private sync(): void {
		this.layer.style.transform = `translateX(${-this.input.scrollLeft}px)`;
	}

	private complete(force: boolean): void {
		const caret = this.input.selectionStart ?? this.input.value.length;
		const word = this.input.selectionEnd === caret ? wordAt(this.input.value, caret, this.flavor) : undefined;
		if (!word || (!force && !word.prefix)) {
			this.hide();
			return;
		}
		const items = suggest(word.prefix, this.clause, this.flavor, this.columns);
		if (!items.length || (!force && items.length === 1 && items[0].label === word.prefix)) {
			this.hide();
			return;
		}
		this.word = word;
		this.items = items.slice(0, 50);
		this.active = 0;
		this.show();
	}

	private show(): void {
		this.popup.replaceChildren(...this.items.map((suggestion, index) => {
			const item = el('div', index === this.active ? 'completion-item active' : 'completion-item');
			item.dataset.index = String(index);
			const label = el('span', 'completion-label');
			label.textContent = suggestion.label;
			const detail = el('span', 'completion-detail');
			detail.textContent = suggestion.detail;
			item.append(iconFor(suggestion), label, detail);
			return item;
		}));
		const context = document.createElement('canvas').getContext('2d');
		const style = getComputedStyle(this.input);
		let offset = 0;
		if (context && this.word) {
			context.font = `${style.fontSize} ${style.fontFamily}`;
			offset = context.measureText(this.input.value.slice(0, this.word.start)).width;
		}
		const box = this.input.getBoundingClientRect();
		const left = Math.min(box.left + offset - this.input.scrollLeft - 24, window.innerWidth - 240);
		this.popup.style.left = `${Math.max(4, left)}px`;
		this.popup.style.top = `${this.root.getBoundingClientRect().bottom + 2}px`;
		this.popup.classList.add('visible');
		this.popup.children[this.active]?.scrollIntoView({ block: 'nearest' });
	}

	private hide(): void {
		this.popup.classList.remove('visible');
		this.items = [];
		this.word = undefined;
	}

	private move(delta: number): void {
		this.active = (this.active + delta + this.items.length) % this.items.length;
		this.show();
	}

	private accept(index: number): void {
		const suggestion = this.items[index];
		const word = this.word;
		if (!suggestion || !word) {
			return;
		}
		const value = this.input.value;
		const end = this.input.selectionStart ?? value.length;
		const before = value.slice(0, word.start);
		this.input.value = `${before}${suggestion.insert}${value.slice(end)}`;
		const caret = before.length + suggestion.insert.length - (suggestion.caret ?? 0);
		this.input.setSelectionRange(caret, caret);
		this.hide();
		this.render();
		this.input.focus();
	}

	private keydown(e: KeyboardEvent): void {
		const open = this.popup.classList.contains('visible');
		const handled = (): void => {
			e.preventDefault();
			e.stopImmediatePropagation();
		};
		if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			handled();
			this.move(e.key === 'ArrowDown' ? 1 : -1);
		} else if (open && (e.key === 'Enter' || e.key === 'Tab')) {
			handled();
			this.accept(this.active);
		} else if (open && e.key === 'Escape') {
			handled();
			this.hide();
		} else if (e.key === ' ' && e.ctrlKey) {
			handled();
			this.complete(true);
		} else {
			requestAnimationFrame(() => {
				this.sync();
				if (open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
					this.complete(false);
				}
			});
		}
	}
}
