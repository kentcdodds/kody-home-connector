// Mirrors SQLite's `ORDER BY x COLLATE NOCASE` (ASCII case folding, then byte order).
export function compareNoCase(a: string, b: string) {
	const left = a.toLowerCase()
	const right = b.toLowerCase()
	if (left < right) return -1
	if (left > right) return 1
	return compareText(a, b)
}

export function compareText(a: string, b: string) {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}

export function compareNullableText(a: string | null, b: string | null) {
	if (a === b) return 0
	if (a === null) return -1
	if (b === null) return 1
	return compareText(a, b)
}
