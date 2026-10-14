import type { Flavor } from '../shared/format';
import type { Value } from '../shared/protocol';

const EXPORT_PAGE_SIZE = 5000;

export interface ExportCursor {
	next(limit: number): Promise<{ rows: Value[][]; done: boolean }>;
	close(): Promise<void>;
}

export interface ExportSource {
	title: string;
	columns: string[];
	table: string;
	flavor: Flavor;
	fetch(offset: number, limit: number): Promise<{ rows: Value[][]; more: boolean }>;
	cursor?(): Promise<ExportCursor>;
}

export async function pages(source: ExportSource, take: (rows: Value[][], first: boolean) => Promise<boolean>): Promise<void> {
	if (source.cursor) {
		const cursor = await source.cursor();
		try {
			let first = true;
			let done = false;
			while (!done) {
				const page = await cursor.next(EXPORT_PAGE_SIZE);
				const keep = await take(page.rows, first);
				done = page.done || !keep;
				first = false;
			}
		} finally {
			await cursor.close();
		}
		return;
	}
	let offset = 0;
	let more = true;
	while (more) {
		const page = await source.fetch(offset, EXPORT_PAGE_SIZE);
		more = (await take(page.rows, offset === 0)) && page.more && page.rows.length > 0;
		offset += page.rows.length;
	}
}
