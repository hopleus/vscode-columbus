const svg = (body: string): string =>
	`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const columnBody = '<path d="M9.5 13.5h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3"/><path d="M6.5 2.5v11"/>';
const keyBody = '<path d="M11.5 6.5h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z"/><path d="M12.5 10.5v4M12.5 12.5h1.5M12.5 14.5h1.5"/>';

export const icons = {
	refresh: svg('<path d="M13.5 8.5a5.5 5.5 0 1 1-1.61-3.89"/><path d="M12.5 1.5v3.5H9"/>'),
	add: svg('<path d="M8.5 3v11M3 8.5h11"/>'),
	remove: svg('<path d="M3 8.5h11"/>'),
	revert: svg('<path d="M5 3 2.5 5.5 5 8"/><path d="M2.5 5.5h7a3.5 3.5 0 0 1 0 7H6"/>'),
	submit: svg('<path d="M8.5 2.5l-5 5h3v6h4v-6h3z"/>'),
	pin: svg('<path d="M6.5 2.5h4M7.5 2.5v4l-2 2.5h6l-2-2.5v-4M8.5 9v4.5"/>'),
	stop: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>'),
	preview: svg('<path d="M1.5 8.5S4 4 8 4s6.5 4.5 6.5 4.5S12 13 8 13s-6.5-4.5-6.5-4.5z"/><circle cx="8" cy="8.5" r="2"/>'),
	commit: svg('<path d="M3 8.5l3.5 3.5 6.5-7"/>'),
	copy: svg('<rect x="5.5" y="5.5" width="8" height="9" rx="1"/><path d="M3.5 11.5h-0a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1"/>'),
	console: svg('<rect x="2.5" y="3.5" width="12" height="10" rx="1"/><path d="M5 7l2 1.5L5 10M8.5 10.5h3"/>'),
	locate: svg('<circle cx="8.5" cy="8.5" r="5"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M8.5 1.5v2M8.5 13.5v2M1.5 8.5h2M13.5 8.5h2"/>'),
	openInTab: svg('<path d="M9.5 2.5h-6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6"/><path d="M12.5 1v5M10 3.5h5"/>'),
	sidePanel: svg('<rect x="2.5" y="3.5" width="12" height="10" rx="1"/><path d="M10.5 3.5v10"/>'),
	search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>'),
	download: svg('<path d="M8.5 2.5v8M5 7.5l3.5 3.5 3.5-3.5M2.5 13.5h12"/>'),
	close: svg('<path d="M4.5 4.5l8 8M12.5 4.5l-8 8"/>'),
	arrowUp: svg('<path d="M8.5 13.5v-10M4.5 7.5l4-4 4 4"/>'),
	arrowDown: svg('<path d="M8.5 3.5v10M4.5 9.5l4 4 4-4"/>'),
	chevronDown: svg('<path d="M4.5 6.5 8 10l3.5-3.5"/>'),
	chevronLeft: svg('<path d="M9.5 4.5 6 8l3.5 3.5"/>'),
	chevronRight: svg('<path d="M6.5 4.5 10 8l-3.5 3.5"/>'),
	filter: svg('<path d="M2.5 3.5h11l-4 5v4.5l-3 1.5v-6z"/>'),
	order: svg('<path d="M2.5 3.5h11M2.5 7.5h8M2.5 11.5h5"/>'),
	sort: svg('<path class="up" d="M5.5 6.5 8 4l2.5 2.5"/><path class="down" d="M5.5 9.5 8 12l2.5-2.5"/>'),
	column: svg('<path d="M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M6.5 2.5v11"/>'),
	columnKey: svg(`${columnBody}<g class="yellow">${keyBody}</g>`),
	columnForeign: svg(`${columnBody}<g class="blue">${keyBody}</g>`),
};
