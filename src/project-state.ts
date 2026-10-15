export const PROJECT_DIR = '.columbus';
export const EXCLUDE_GLOB = `**/${PROJECT_DIR}`;

export function withExclude(exclude: Record<string, boolean> | undefined, hide: boolean): Record<string, boolean> | undefined {
	const next = { ...exclude };
	if (hide) {
		if (next[EXCLUDE_GLOB] === true) {
			return undefined;
		}
		next[EXCLUDE_GLOB] = true;
	} else {
		if (!(EXCLUDE_GLOB in next)) {
			return undefined;
		}
		delete next[EXCLUDE_GLOB];
	}
	return next;
}
