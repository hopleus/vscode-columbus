export interface SearchOptions {
	matchCase: boolean;
	words: boolean;
	regex: boolean;
}

export function searchPattern(query: string, options: SearchOptions): RegExp | undefined {
	if (!query) {
		return undefined;
	}
	const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const bounded = options.words ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
	return new RegExp(bounded, options.matchCase ? 'u' : 'iu');
}
