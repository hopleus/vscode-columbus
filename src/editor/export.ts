import { once } from 'events';
import { createWriteStream } from 'fs';
import { rm } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { EXTRACTORS } from '../shared/extract';
import type { ExtractorId } from '../shared/extract';
import type { CursorRequest, Driver } from '../drivers/driver';
import { pages } from './pages';
import type { ExportCursor, ExportSource } from './pages';

export type { ExportCursor, ExportSource };

async function collect(source: ExportSource, format: ExtractorId): Promise<string> {
	const extractor = EXTRACTORS[format];
	const target = { columns: source.columns, table: source.table, flavor: source.flavor };
	const parts = [extractor.header(target)];
	await pages(source, async (rows, first) => {
		parts.push(extractor.rows(target, rows, first));
		return true;
	});
	parts.push(extractor.footer(target));
	return parts.join('');
}

export async function exportRows(source: ExportSource, format: ExtractorId, clipboard = false): Promise<void> {
	if (clipboard) {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Copying ${source.title}` },
			async () => vscode.env.clipboard.writeText(await collect(source, format))
		);
		return;
	}
	const extractor = EXTRACTORS[format];
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const file = `${source.title}.${extractor.extension}`;
	const uri = await vscode.window.showSaveDialog({
		defaultUri: folder ? vscode.Uri.joinPath(folder, file) : vscode.Uri.file(join(homedir(), file)),
		filters: { [extractor.label]: [extractor.extension] },
		title: `Export ${source.title}`,
	});
	if (!uri) {
		return;
	}
	const target = { columns: source.columns, table: source.table, flavor: source.flavor };
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Columbus: exporting ${source.title}`, cancellable: true },
		async (progress, token) => {
			const stream = createWriteStream(uri.fsPath);
			const write = async (text: string): Promise<void> => {
				if (text && !stream.write(text)) {
					await once(stream, 'drain');
				}
			};
			try {
				await write(extractor.header(target));
				let count = 0;
				await pages(source, async (rows, first) => {
					await write(extractor.rows(target, rows, first));
					count += rows.length;
					progress.report({ message: `${count.toLocaleString('en-US')} rows` });
					return !token.isCancellationRequested;
				});
				await write(extractor.footer(target));
			} finally {
				stream.end();
				await once(stream, 'close');
			}
			if (token.isCancellationRequested) {
				await rm(uri.fsPath, { force: true });
			}
		}
	);
}

export async function tableCursor(driver: Driver, request: CursorRequest): Promise<ExportCursor> {
	const id = await driver.openCursor(request);
	return {
		next: limit => driver.fetchCursor(id, limit),
		close: () => driver.closeCursor(id),
	};
}
