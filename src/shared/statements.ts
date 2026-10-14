import type { Flavor } from './format';

export interface StatementRange {
	start: number;
	end: number;
	text: string;
}

const DOLLAR_TAG = /\$(?:[A-Za-z_][\w]*)?\$/y;
const WORD = /[A-Za-z_][\w$]*/y;

function skipQuoted(text: string, start: number, quote: string, backslash: boolean): number {
	let i = start + 1;
	while (i < text.length) {
		if (backslash && text[i] === '\\') {
			i += 2;
		} else if (text[i] === quote) {
			if (text[i + 1] !== quote) {
				return i + 1;
			}
			i += 2;
		} else {
			i++;
		}
	}
	return text.length;
}

function skipLine(text: string, start: number): number {
	const end = text.indexOf('\n', start);
	return end < 0 ? text.length : end + 1;
}

function skipBlock(text: string, start: number): number {
	const end = text.indexOf('*/', start + 2);
	return end < 0 ? text.length : end + 2;
}

function hasCode(text: string, flavor: Flavor): boolean {
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) {
			i++;
		} else if (text.startsWith('--', i) || (flavor === 'mysql' && text[i] === '#')) {
			i = skipLine(text, i);
		} else if (text.startsWith('/*', i)) {
			i = skipBlock(text, i);
		} else {
			return true;
		}
	}
	return false;
}

export function splitStatements(text: string, flavor: Flavor): StatementRange[] {
	const ranges: StatementRange[] = [];
	const push = (from: number, to: number): void => {
		const chunk = text.slice(from, to);
		if (!hasCode(chunk, flavor)) {
			return;
		}
		const start = from + (chunk.length - chunk.trimStart().length);
		const end = to - (chunk.length - chunk.trimEnd().length);
		ranges.push({ start, end, text: text.slice(start, end) });
	};
	let from = 0;
	let i = 0;
	let words: string[] = [];
	let trigger = false;
	let depth = 0;
	while (i < text.length) {
		const char = text[i];
		if (text.startsWith('--', i) || (flavor === 'mysql' && char === '#')) {
			i = skipLine(text, i);
		} else if (text.startsWith('/*', i)) {
			i = skipBlock(text, i);
		} else if (char === "'" || char === '"' || (char === '`' && flavor !== 'postgres')) {
			i = skipQuoted(text, i, char, flavor === 'mysql' && char !== '`');
		} else if (char === '[' && flavor === 'sqlite') {
			const close = text.indexOf(']', i + 1);
			i = close < 0 ? text.length : close + 1;
		} else if (flavor === 'sqlite' && /[A-Za-z_]/.test(char)) {
			WORD.lastIndex = i;
			const word = (WORD.exec(text)?.[0] ?? char).toUpperCase();
			if (words.length < 3) {
				words.push(word);
				trigger = words[0] === 'CREATE' && (words[1] === 'TRIGGER' || (/^TEMP(ORARY)?$/.test(words[1] ?? '') && words[2] === 'TRIGGER'));
			}
			if (trigger && (word === 'BEGIN' || word === 'CASE')) {
				depth++;
			} else if (trigger && word === 'END') {
				depth--;
			}
			i += word.length;
		} else if (char === '$' && flavor === 'postgres') {
			DOLLAR_TAG.lastIndex = i;
			const tag = DOLLAR_TAG.exec(text)?.[0];
			if (tag) {
				const close = text.indexOf(tag, i + tag.length);
				i = close < 0 ? text.length : close + tag.length;
			} else {
				i++;
			}
		} else if (char === ';' && !(trigger && depth > 0)) {
			push(from, i);
			from = i + 1;
			i++;
			words = [];
			trigger = false;
			depth = 0;
		} else {
			i++;
		}
	}
	push(from, text.length);
	return ranges;
}

export function statementAt(ranges: readonly StatementRange[], text: string, offset: number): StatementRange | undefined {
	const inside = ranges.find(r => offset >= r.start && offset <= r.end);
	if (inside) {
		return inside;
	}
	const before = [...ranges].reverse().find(r => r.end <= offset);
	if (before && !text.slice(before.end, offset).includes('\n')) {
		return before;
	}
	const after = ranges.find(r => r.start >= offset);
	if (after && !text.slice(offset, after.start).trim()) {
		return after;
	}
	return before && !text.slice(before.end, offset).replace(/;/, '').trim() ? before : undefined;
}
