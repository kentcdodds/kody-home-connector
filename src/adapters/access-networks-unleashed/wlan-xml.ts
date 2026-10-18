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

/** A `<wlansvc>` that could not be addressed by id (missing or blank id). */
export type WlanListAnomaly = {
	/** Zero-based position in wlansvc-list (diagnostic only; never a write target). */
	index: number
	kind: 'missing-id'
	name: string | null
	ssid: string | null
	rawXml: string
}

export type ParsedWlanList = {
	/** Entries that carry an id, in list order. */
	entries: Array<WlanSvcEntry>
	/** Entries the controller returned without an id (e.g. Oct 17 overwrite). */
	anomalies: Array<WlanListAnomaly>
	/** Ids that appear more than once (e.g. Oct 12 overwrite). */
	duplicateIds: Array<string>
}

const wlansvcElementRegex =
	/<wlansvc(?=[\s>/])(?<attrs>[^>]*?)\/>|<wlansvc(?=[\s>/])(?<openAttrs>[^>]*)>(?<body>[\s\S]*?)<\/wlansvc>/gi

/**
 * Lenient parse of every top-level `<wlansvc>` element. Never throws on
 * content: id-less entries are reported as anomalies instead, so reads keep
 * working and post-write checks can trigger rollback instead of aborting.
 */
export function parseWlansvcList(xml: string): ParsedWlanList {
	const entries: Array<WlanSvcEntry> = []
	const anomalies: Array<WlanListAnomaly> = []
	let index = 0
	for (const match of xml.matchAll(wlansvcElementRegex)) {
		const rawXml = match[0]
		const attrText = match.groups?.attrs ?? match.groups?.openAttrs ?? ''
		const attributes = parseAttributes(attrText)
		const id = attributes['id']?.trim() ?? ''
		if (!id) {
			anomalies.push({
				index,
				kind: 'missing-id',
				name: attributes['name'] ?? null,
				ssid: attributes['ssid'] ?? null,
				rawXml,
			})
		} else {
			entries.push({
				id,
				name: attributes['name'] ?? null,
				ssid: attributes['ssid'] ?? null,
				attributes,
				rawXml,
			})
		}
		index += 1
	}
	return { entries, anomalies, duplicateIds: findDuplicateIds(entries) }
}

/**
 * Strict variant: throws when any `<wlansvc>` lacks an id. Kept for callers
 * that must never operate on an incomplete list; WLAN ops use
 * {@link parseWlansvcList} so they can report and roll back instead.
 */
export function extractWlansvcEntries(xml: string): Array<WlanSvcEntry> {
	const parsed = parseWlansvcList(xml)
	if (parsed.anomalies.length > 0) {
		throw new Error(
			'wlansvc-list contains a <wlansvc> without an id attribute. Refusing to snapshot or mutate an incomplete WLAN list.',
		)
	}
	return parsed.entries
}

/** Allow only plain Unleashed attribute names (no markup injection). */
export function assertSafeWlanAttributeName(name: string) {
	if (!/^[\w:-]+$/.test(name)) {
		throw new Error(
			`Invalid WLAN attribute name "${name}". Names may only contain letters, digits, underscore, colon, or hyphen.`,
		)
	}
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
		assertSafeWlanAttributeName(name)
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
		assertSafeWlanAttributeName(name)
		updated = setOrAddAttribute(updated, name, value)
	}
	return updated
}

/**
 * Build the expected post-update rawXml by applying only the requested
 * attribute patches to the pre-write element. Used to detect unintended
 * mutations on the target WLAN itself.
 */
export function expectPatchedWlanXml(
	beforeRawXml: string,
	attributes: Record<string, string>,
): string {
	return applyWlanAttributeOverrides(beforeRawXml, attributes)
}

const secretAttributeNames = new Set([
	'passphrase',
	'sae-passphrase',
	'guest-pass',
	'psk',
	'key',
	'wep-key',
	'secret',
	'shared-secret',
	'radius-secret',
])

/**
 * True for attribute names that carry Wi-Fi / portal secrets. Every `x-`
 * attribute is the controller's obfuscated twin of a secret (aioruckus:
 * "x-psk" pairs with "psk"), so those are always treated as secret.
 */
export function isSecretWlanAttributeName(name: string): boolean {
	const lower = name.toLowerCase()
	return lower.startsWith('x-') || secretAttributeNames.has(lower)
}

const anyAttributeRegex = /(\s)([:\w-]+)(\s*=\s*)(["'])(.*?)\4/gs

/**
 * Replace the value of every secret attribute anywhere in an XML string
 * (root and children). Empty values stay empty so "no secret" is still
 * distinguishable from "secret present" in diagnostics.
 */
export function redactSecretsInXmlText(xml: string): string {
	return xml.replace(
		anyAttributeRegex,
		(
			match,
			space: string,
			name: string,
			eq: string,
			quote: string,
			value: string,
		) => {
			if (!isSecretWlanAttributeName(name)) return match
			const replacement = value.length === 0 ? '' : '[redacted]'
			return `${space}${name}${eq}${quote}${replacement}${quote}`
		},
	)
}

/** Redact Wi-Fi secrets from tool-facing WLAN payloads. */
export function redactWlanSecrets(entry: WlanSvcEntry): WlanSvcEntry {
	const attributes: Record<string, string> = {}
	for (const [name, value] of Object.entries(entry.attributes)) {
		attributes[name] =
			isSecretWlanAttributeName(name) && value.length > 0 ? '[redacted]' : value
	}
	return {
		...entry,
		attributes,
		rawXml: redactSecretsInXmlText(entry.rawXml),
	}
}

/** Redact secrets in a root-attribute map (for tool output). */
export function redactSecretAttributes(
	attributes: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [name, value] of Object.entries(attributes)) {
		result[name] =
			isSecretWlanAttributeName(name) && value.length > 0 ? '[redacted]' : value
	}
	return result
}

/** Remove the named attributes from the root element's open tag only. */
export function removeRootAttributes(
	elementXml: string,
	names: ReadonlyArray<string>,
): string {
	const openTagMatch = /^<(\w[\w-]*)([^>]*?)(\/?)>/i.exec(elementXml)
	if (!openTagMatch) return elementXml
	const tagName = openTagMatch[1] ?? ''
	let attributes = openTagMatch[2] ?? ''
	for (const name of names) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		attributes = attributes.replace(
			new RegExp(`\\s+${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'gi'),
			'',
		)
	}
	return `<${tagName}${attributes}${openTagMatch[3] ?? ''}>${elementXml.slice(openTagMatch[0].length)}`
}

type CanonicalElement = {
	attributes: Record<string, string>
	children: Record<string, Array<CanonicalElement>>
}

function parseCanonicalElement(xml: string): CanonicalElement | null {
	// Minimal recursive element parser (attribute values never contain '<').
	const tagRegex = /<(\/?)([\w:-]+)([^>]*?)(\/?)>/g
	const stack: Array<{ name: string; element: CanonicalElement }> = []
	let root: CanonicalElement | null = null
	for (const match of xml.matchAll(tagRegex)) {
		const closing = match[1] === '/'
		const name = match[2] ?? ''
		const selfClosing = match[4] === '/'
		if (closing) {
			stack.pop()
			continue
		}
		const element: CanonicalElement = {
			attributes: parseAttributes(match[3] ?? ''),
			children: {},
		}
		const parent = stack[stack.length - 1]
		if (parent) {
			const list = parent.element.children[name] ?? []
			list.push(element)
			parent.element.children[name] = list
		} else if (!root) {
			root = element
		}
		if (!selfClosing) stack.push({ name, element })
	}
	return root
}

function stableSerialize(
	element: CanonicalElement,
	ignore: (name: string, depth: number) => boolean,
	depth = 0,
): string {
	const attrs = Object.keys(element.attributes)
		.filter((name) => !ignore(name, depth))
		.sort()
		.map((name) => `${name}=${JSON.stringify(element.attributes[name])}`)
	const children = Object.keys(element.children)
		.sort()
		.map(
			(name) =>
				`${name}[${(element.children[name] ?? [])
					.map((child) => stableSerialize(child, ignore, depth + 1))
					.join(',')}]`,
		)
	return `{${attrs.join(' ')}|${children.join(' ')}}`
}

/**
 * Order-insensitive fingerprint of a `<wlansvc>` element (root attributes +
 * child elements). `x-` obfuscated secret twins are ignored because their
 * encoding is not guaranteed stable across reads; the plaintext secret is
 * compared instead. `ignoreRootAttributes` drops controller bookkeeping such
 * as `id` / `create-time` when comparing a re-created object.
 */
export function canonicalWlanFingerprint(
	elementXml: string,
	options?: { ignoreRootAttributes?: ReadonlyArray<string> },
): string {
	const element = parseCanonicalElement(elementXml)
	if (!element) return elementXml
	const ignoredRoot = new Set(
		(options?.ignoreRootAttributes ?? []).map((name) => name.toLowerCase()),
	)
	return stableSerialize(element, (name, depth) => {
		const lower = name.toLowerCase()
		if (lower.startsWith('x-')) return true
		return depth === 0 && ignoredRoot.has(lower)
	})
}

/** Attributes of the first direct child element named `childName`. */
export function getChildElementAttributes(
	elementXml: string,
	childName: string,
): Record<string, string> | null {
	const element = parseCanonicalElement(elementXml)
	const child = element?.children[childName]?.[0]
	return child ? { ...child.attributes } : null
}

/**
 * True when every attribute (root and child elements) in `expectedXml` has
 * the same value in `actualXml`. Extra attributes on `actual` (controller
 * defaults added on create) are allowed. `x-` twins are ignored.
 */
export function wlanXmlContainsExpected(input: {
	expectedXml: string
	actualXml: string
	ignoreRootAttributes?: ReadonlyArray<string>
}): { ok: true } | { ok: false; mismatch: string } {
	const expected = parseCanonicalElement(input.expectedXml)
	const actual = parseCanonicalElement(input.actualXml)
	if (!expected || !actual) return { ok: false, mismatch: 'unparseable XML' }
	const ignoredRoot = new Set(
		(input.ignoreRootAttributes ?? []).map((name) => name.toLowerCase()),
	)
	function compare(
		exp: CanonicalElement,
		act: CanonicalElement,
		path: string,
		depth: number,
	): string | null {
		for (const [name, value] of Object.entries(exp.attributes)) {
			const lower = name.toLowerCase()
			if (lower.startsWith('x-')) continue
			if (depth === 0 && ignoredRoot.has(lower)) continue
			if (act.attributes[name] !== value) {
				// Never echo secret values into mismatch text.
				return isSecretWlanAttributeName(name)
					? `${path}@${name} differs`
					: `${path}@${name} expected "${value}" but found "${act.attributes[name] ?? '(missing)'}"`
			}
		}
		for (const [childName, children] of Object.entries(exp.children)) {
			const actualChildren = act.children[childName] ?? []
			for (const [childIndex, child] of children.entries()) {
				const actualChild = actualChildren[childIndex]
				if (!actualChild) return `${path}/${childName} is missing`
				const nested = compare(
					child,
					actualChild,
					`${path}/${childName}`,
					depth + 1,
				)
				if (nested) return nested
			}
		}
		return null
	}
	const mismatch = compare(expected, actual, 'wlansvc', 0)
	return mismatch ? { ok: false, mismatch } : { ok: true }
}

/**
 * Explain why an entry's snapshot could not restore its secrets, or return
 * an empty list when it can. A WPA2/WPA3 PSK WLAN must carry its passphrase
 * (plaintext or `x-` twin) in the snapshot; getconf with DECRYPT_X="false"
 * omits it on Unleashed 200.x (observed Oct 17 2026), which is why the
 * friendlyfamily backup had no passphrase.
 */
export function findUnrestorableSecrets(entry: WlanSvcEntry): Array<string> {
	const encryption = (entry.attributes['encryption'] ?? 'none').toLowerCase()
	const authentication = (
		entry.attributes['authentication'] ?? ''
	).toLowerCase()
	if (encryption === 'none' || encryption === '' || encryption === 'owe') {
		return []
	}
	if (/802\.1x|eap/.test(authentication)) return []
	const wpa = getChildElementAttributes(entry.rawXml, 'wpa')
	if (!wpa) return [`encryption "${encryption}" but no <wpa> element`]
	const has = (name: string) =>
		Boolean(wpa[name]?.length) || Boolean(wpa[`x-${name}`]?.length)
	const problems: Array<string> = []
	if (
		(encryption === 'wpa2' ||
			encryption === 'wpa23-mixed' ||
			encryption === 'wpa-mixed' ||
			encryption === 'wpa') &&
		!has('passphrase')
	) {
		problems.push('WPA passphrase missing from snapshot')
	}
	if (
		(encryption === 'wpa3' || encryption === 'wpa23-mixed') &&
		!has('sae-passphrase')
	) {
		problems.push('SAE passphrase missing from snapshot')
	}
	return problems
}

/**
 * True when a setconf body is a single non-partial, non-delete wlansvc object.
 * Those full-object writes are the Oct 12 failure mode when applied by position.
 */
export function xmlBodyLooksLikeFullObjectWlanWrite(xmlBody: string): boolean {
	if (xmlBodyLooksLikeFullWlanListWrite(xmlBody)) return false
	if (countTopLevelWlansvcElements(xmlBody) !== 1) return false
	if (/IS_PARTIAL\s*=\s*(['"])true\1/i.test(xmlBody)) return false
	if (/DELETE\s*=\s*(['"])true\1/i.test(xmlBody)) return false
	return /<wlansvc(?=[\s>/])/i.test(xmlBody)
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
