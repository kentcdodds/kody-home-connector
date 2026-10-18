/**
 * String-level helpers for Unleashed `<wlansvc>` config XML.
 *
 * Round-tripping through the generic XML parser would lose attribute order and
 * child layout that the controller expects on setconf, so WLAN ops keep the
 * raw element text from getconf and surgically edit attributes.
 */

export type WlanSvcEntry = {
	id: string
	name: string | null
	ssid: string | null
	attributes: Record<string, string>
	rawXml: string
}

export function escapeXmlAttribute(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

export function decodeXmlEntities(value: string) {
	return value.replace(
		/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi,
		(match, entity) => {
			const normalized = String(entity).toLowerCase()
			if (normalized.startsWith('#x')) {
				return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16))
			}
			if (normalized.startsWith('#')) {
				return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10))
			}
			const named: Record<string, string> = {
				amp: '&',
				lt: '<',
				gt: '>',
				quot: '"',
				apos: "'",
			}
			return named[normalized] ?? match
		},
	)
}

function escapeReplacementString(value: string) {
	return value.replace(/\$/g, '$$$$')
}

/**
 * Extract every top-level `<wlansvc>...</wlansvc>` (or self-closing) element.
 * Nested tags inside a wlansvc are preserved; nested wlansvc is not expected.
 */
export function extractWlansvcEntries(xml: string): Array<WlanSvcEntry> {
	const entries: Array<WlanSvcEntry> = []
	const elementRegex =
		/<wlansvc(?=[\s>/])(?<attrs>[^>]*)\/>|<wlansvc(?=[\s>/])(?<openAttrs>[^>]*)>(?<body>[\s\S]*?)<\/wlansvc>/gi
	for (const match of xml.matchAll(elementRegex)) {
		const rawXml = match[0]
		const attrText = match.groups?.attrs ?? match.groups?.openAttrs ?? ''
		const attributes = parseAttributes(attrText)
		const id = attributes['id']?.trim() ?? ''
		if (!id) {
			// Config entries from getconf wlansvc-list always carry id. Skip
			// incomplete fragments rather than inventing keys.
			continue
		}
		entries.push({
			id,
			name: attributes['name'] ?? null,
			ssid: attributes['ssid'] ?? null,
			attributes,
			rawXml,
		})
	}
	return entries
}

function parseAttributes(attrText: string): Record<string, string> {
	const attributes: Record<string, string> = {}
	const attributeRegex = /([:\w-]+)\s*=\s*(["'])(.*?)\2/gs
	for (const match of attrText.matchAll(attributeRegex)) {
		const key = String(match[1] ?? '').trim()
		if (!key) continue
		attributes[key] = decodeXmlEntities(match[3] ?? '')
	}
	return attributes
}

export function getAttributeValue(
	elementXml: string,
	name: string,
): string | null {
	const attrPattern = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i')
	const match = attrPattern.exec(elementXml)
	return match ? decodeXmlEntities(match[2] ?? '') : null
}

export function setOrAddAttribute(
	elementXml: string,
	name: string,
	value: string,
): string {
	const escapedValue = escapeXmlAttribute(value)
	const replacementSafeValue = escapeReplacementString(escapedValue)
	const firstClose = elementXml.indexOf('>')
	if (firstClose === -1) return elementXml
	const openTag = elementXml.slice(0, firstClose + 1)
	const rest = elementXml.slice(firstClose + 1)
	const attrPattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, 'i')
	if (attrPattern.test(openTag)) {
		return openTag.replace(attrPattern, `$1'${replacementSafeValue}'`) + rest
	}
	return (
		openTag.replace(/^<(\w[\w-]*)/i, `<$1 ${name}='${replacementSafeValue}'`) +
		rest
	)
}

export function removeRootIdAttribute(elementXml: string): string {
	const openTagMatch = /^<(\w[\w-]*)([^>]*)>/i.exec(elementXml)
	if (!openTagMatch) return elementXml
	const tagName = openTagMatch[1] ?? ''
	let attributes = openTagMatch[2] ?? ''
	attributes = attributes.replace(/\s+id\s*=\s*(["'])(.*?)\1/i, '')
	return `<${tagName}${attributes}>${elementXml.slice(openTagMatch[0].length)}`
}

export function findDuplicateIds(entries: Array<WlanSvcEntry>): Array<string> {
	const seen = new Map<string, number>()
	for (const entry of entries) {
		seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1)
	}
	return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)
}

export function indexWlansById(
	entries: Array<WlanSvcEntry>,
): Map<string, WlanSvcEntry> {
	const map = new Map<string, WlanSvcEntry>()
	for (const entry of entries) {
		map.set(entry.id, entry)
	}
	return map
}

export type WlanListDiff = {
	duplicateIds: Array<string>
	missingIds: Array<string>
	addedIds: Array<string>
	changedUnexpectedIds: Array<string>
	ok: boolean
	summary: string
}

/**
 * Compare two WLAN snapshots.
 *
 * `allowedChangedIds` may change (rawXml can differ). Every other id that
 * existed before must still exist with identical rawXml. Duplicate ids always
 * fail. Missing pre-existing ids always fail.
 */
export function diffWlanLists(input: {
	before: Array<WlanSvcEntry>
	after: Array<WlanSvcEntry>
	allowedChangedIds?: ReadonlySet<string>
	allowedAddedIds?: ReadonlySet<string>
}): WlanListDiff {
	const allowedChanged = input.allowedChangedIds ?? new Set<string>()
	const allowedAdded = input.allowedAddedIds ?? new Set<string>()
	const beforeById = indexWlansById(input.before)
	const afterById = indexWlansById(input.after)
	const duplicateIds = findDuplicateIds(input.after)
	const missingIds: Array<string> = []
	const changedUnexpectedIds: Array<string> = []
	const addedIds: Array<string> = []

	for (const id of beforeById.keys()) {
		const after = afterById.get(id)
		if (!after) {
			missingIds.push(id)
			continue
		}
		const before = beforeById.get(id)
		if (!before) continue
		if (before.rawXml === after.rawXml) continue
		if (!allowedChanged.has(id)) {
			changedUnexpectedIds.push(id)
		}
	}

	for (const id of afterById.keys()) {
		if (!beforeById.has(id) && !allowedAdded.has(id)) {
			addedIds.push(id)
		}
	}

	const problems: Array<string> = []
	if (duplicateIds.length > 0) {
		problems.push(`duplicate wlansvc id(s): ${duplicateIds.join(', ')}`)
	}
	if (missingIds.length > 0) {
		problems.push(`missing wlansvc id(s): ${missingIds.join(', ')}`)
	}
	if (changedUnexpectedIds.length > 0) {
		problems.push(
			`unexpected change to wlansvc id(s): ${changedUnexpectedIds.join(', ')}`,
		)
	}
	if (addedIds.length > 0) {
		problems.push(`unexpected new wlansvc id(s): ${addedIds.join(', ')}`)
	}

	const ok = problems.length === 0
	return {
		duplicateIds,
		missingIds,
		addedIds,
		changedUnexpectedIds,
		ok,
		summary: ok
			? 'WLAN list matches the intended change.'
			: `WLAN list safety check failed: ${problems.join('; ')}.`,
	}
}

export function buildPartialWlanUpdateXml(input: {
	id: string
	attributes: Record<string, string>
}): string {
	const parts = [`id='${escapeXmlAttribute(input.id)}'`, `IS_PARTIAL='true'`]
	for (const [name, value] of Object.entries(input.attributes)) {
		if (name === 'id' || name === 'IS_PARTIAL' || name === 'DELETE') continue
		parts.push(`${name}='${escapeXmlAttribute(value)}'`)
	}
	return `<wlansvc ${parts.join(' ')}/>`
}

export function applyWlanAttributeOverrides(
	elementXml: string,
	attributes: Record<string, string>,
): string {
	let updated = elementXml
	for (const [name, value] of Object.entries(attributes)) {
		if (name === 'id') continue
		updated = setOrAddAttribute(updated, name, value)
	}
	return updated
}

/**
 * Count `<wlansvc` open tags in an ajax-request inner body.
 * Used to refuse whole-list setconf payloads on the raw request tool.
 */
export function countTopLevelWlansvcElements(xmlBody: string): number {
	return [...xmlBody.matchAll(/<wlansvc(?=[\s>/])/gi)].length
}

export function xmlBodyLooksLikeFullWlanListWrite(xmlBody: string): boolean {
	if (/<wlansvc-list[\s>/]/i.test(xmlBody)) return true
	return countTopLevelWlansvcElements(xmlBody) > 1
}
