import { type AccessNetworksUnleashedClient } from './types.ts'
import {
	applyWlanAttributeOverrides,
	assertSafeWlanAttributeName,
	buildPartialWlanUpdateXml,
	canonicalWlanFingerprint,
	countTopLevelWlansvcElements,
	decodeXmlEntities,
	escapeXmlAttribute,
	findUnrestorableSecrets,
	getAttributeValue,
	indexWlansById,
	isSecretWlanAttributeName,
	parseWlansvcList,
	redactSecretsInXmlText,
	removeRootAttributes,
	wlanXmlContainsExpected,
	type WlanListAnomaly,
	type WlanSvcEntry,
} from './wlan-xml.ts'

export const wlanListComp = 'wlansvc-list'

/**
 * Root attributes the controller owns. They are stripped from create
 * payloads and ignored when comparing a re-created object to its snapshot.
 */
const controllerOwnedRootAttributes = ['id', 'create-time'] as const

export type WlanRadioBand = 'all' | '2.4ghz' | '5ghz' | '6ghz'

export type WlanAttributeOverrides = {
	name?: string
	ssid?: string
	description?: string
	vlanId?: string | number
	clientIsolation?: string
	/**
	 * Radio band restriction. Unleashed stores this per WLAN as the boolean
	 * `wlan-bind-24g` / `wlan-bind-5g` / `wlan-bind-6g` attributes (see
	 * getconf wlansvc-list on fw 200.x). There is no `radio` attribute.
	 */
	radioBand?: WlanRadioBand
	/**
	 * Exact Unleashed wlansvc root attribute names → values. Every name must
	 * already exist on the source WLAN (unknown attributes are refused because
	 * Unleashed does not validate config writes).
	 */
	attributes?: Record<string, string>
}

export type WlanListRead = {
	xml: string
	entries: Array<WlanSvcEntry>
	anomalies: Array<WlanListAnomaly>
	duplicateIds: Array<string>
}

/** Pre-write snapshot: clean list, secrets captured, safe to restore. */
export type WlanSnapshot = {
	entries: Array<WlanSvcEntry>
	/**
	 * Ids whose passphrase could not be captured. Only non-empty when the
	 * caller explicitly passed acceptUnrestorablePassphrases. Rollback never
	 * rewrites the <wpa> child or re-creates these WLANs.
	 */
	unrestorableIds: Array<string>
}

export type WlanWriteOptions = {
	/**
	 * Proceed even though some WLANs' passphrases could not be captured in the
	 * snapshot. Rollback then restores only their root attributes and never
	 * re-creates them. Default false: such writes are refused.
	 */
	acceptUnrestorablePassphrases?: boolean
	/**
	 * When true: take the restorable snapshot, build the exact object
	 * request(s), and return them without sending anything. Secrets in the
	 * planned request bodies are redacted. Does not require the live write
	 * gate to be enabled.
	 */
	dryRun?: boolean
}

/** One planned `_conf.jsp` object request (secrets already redacted). */
export type WlanPlannedRequest = {
	action: 'addobj' | 'updobj' | 'delobj'
	comp: typeof wlanListComp
	xmlBody: string
}

export type WlanRestoreAction = {
	op: 'updobj' | 'addobj' | 'delobj'
	id: string | null
	name: string | null
	ok: boolean
	error?: string
	/** For addobj: the id the controller assigned to the re-created WLAN. */
	newId?: string | null
}

export type WlanRestoreReport = {
	status: 'restored' | 'partial' | 'failed' | 'not-needed'
	actions: Array<WlanRestoreAction>
	/** Human-readable problems that need manual repair (no secrets). */
	unresolved: Array<string>
	/** Snapshot id → new id for WLANs that had to be re-created via addobj. */
	reassignedIds: Record<string, string>
}

export type WlanWriteSafetyResult = {
	rolledBack: boolean
	problems: Array<string>
	snapshotEntryCount: number
	afterEntryCount: number | null
	restore: WlanRestoreReport | null
}

export class AccessNetworksUnleashedWlanSafetyError extends Error {
	readonly safety: WlanWriteSafetyResult

	constructor(message: string, safety: WlanWriteSafetyResult) {
		super(message)
		this.name = 'AccessNetworksUnleashedWlanSafetyError'
		this.safety = safety
	}
}

/** Thrown before any write is sent; the controller was not touched. */
export class AccessNetworksUnleashedWlanWriteRefusedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AccessNetworksUnleashedWlanWriteRefusedError'
	}
}

const radioBandToBindings: Record<
	WlanRadioBand,
	{ 'wlan-bind-24g': string; 'wlan-bind-5g': string; 'wlan-bind-6g': string }
> = {
	all: {
		'wlan-bind-24g': 'true',
		'wlan-bind-5g': 'true',
		'wlan-bind-6g': 'true',
	},
	'2.4ghz': {
		'wlan-bind-24g': 'true',
		'wlan-bind-5g': 'false',
		'wlan-bind-6g': 'false',
	},
	'5ghz': {
		'wlan-bind-24g': 'false',
		'wlan-bind-5g': 'true',
		'wlan-bind-6g': 'false',
	},
	'6ghz': {
		'wlan-bind-24g': 'false',
		'wlan-bind-5g': 'false',
		'wlan-bind-6g': 'true',
	},
}

/** Attribute names callers may never set through WLAN write tools. */
const forbiddenOverrideNames = new Set([
	'id',
	'is_partial',
	'delete',
	'create-time',
	// Legacy, never-valid mapping used by radioBand before Oct 17 2026.
	'radio',
])

export function resolveWlanAttributeOverrides(
	overrides: WlanAttributeOverrides,
): Record<string, string> {
	const attributes: Record<string, string> = {
		...overrides.attributes,
	}
	if (overrides.name !== undefined) attributes['name'] = overrides.name
	if (overrides.ssid !== undefined) attributes['ssid'] = overrides.ssid
	if (overrides.description !== undefined) {
		attributes['description'] = overrides.description
	}
	if (overrides.vlanId !== undefined) {
		attributes['vlan-id'] = String(overrides.vlanId)
	}
	if (overrides.clientIsolation !== undefined) {
		attributes['client-isolation'] = overrides.clientIsolation
	}
	if (overrides.radioBand !== undefined) {
		const bindings = radioBandToBindings[overrides.radioBand]
		for (const [name, value] of Object.entries(bindings)) {
			const explicit = overrides.attributes?.[name]
			if (explicit !== undefined && explicit !== value) {
				throw new Error(
					`radioBand "${overrides.radioBand}" sets ${name}="${value}" but attributes also sets ${name}="${explicit}". Pass one or the other.`,
				)
			}
			attributes[name] = value
		}
	}
	return attributes
}

/**
 * Validate write attributes against the target/source element: names must be
 * plain, must not be controller-owned or secret, and must already exist on
 * the element (Unleashed does no validation and can crash-loop on bad data).
 */
function assertWritableAttributes(input: {
	attributes: Record<string, string>
	element: WlanSvcEntry
	context: string
}) {
	for (const name of Object.keys(input.attributes)) {
		assertSafeWlanAttributeName(name)
		if (forbiddenOverrideNames.has(name.toLowerCase())) {
			throw new AccessNetworksUnleashedWlanWriteRefusedError(
				name.toLowerCase() === 'radio'
					? `Refusing ${input.context}: "radio" is not an Unleashed wlansvc attribute. Use radioBand (maps to wlan-bind-24g / wlan-bind-5g / wlan-bind-6g) or set those attributes directly.`
					: `Refusing ${input.context}: attribute "${name}" is controller-owned and cannot be set.`,
			)
		}
		if (isSecretWlanAttributeName(name)) {
			throw new AccessNetworksUnleashedWlanWriteRefusedError(
				`Refusing ${input.context}: attribute "${name}" is a secret. Changing WLAN secrets is not supported by this tool.`,
			)
		}
		if (!(name in input.element.attributes)) {
			throw new AccessNetworksUnleashedWlanWriteRefusedError(
				`Refusing ${input.context}: attribute "${name}" does not exist on WLAN id "${input.element.id}". Unleashed does not validate config writes, so only attributes the controller already reports may be set.`,
			)
		}
	}
}

// ---------------------------------------------------------------------------
// Wire-level guard
// ---------------------------------------------------------------------------

export type WlanWriteAction = 'addobj' | 'updobj' | 'delobj'

/**
 * Every WLAN write must name its target explicitly:
 * - `updobj` / `delobj`: exactly one `<wlansvc>` carrying a non-empty `id`.
 * - `addobj`: exactly one `<wlansvc>` with NO `id` (the controller assigns it).
 * `setconf` is refused outright for wlansvc-list: on Unleashed 200.x it was
 * observed twice (Oct 12 with id="5", Oct 17 with no id) to overwrite the
 * FIRST wlansvc in the list regardless of the payload's id.
 */
export function assertTargetedWlanWrite(action: string, xmlBody: string) {
	if (action === 'setconf') {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			'Refusing setconf on wlansvc-list: Unleashed applies a single-<wlansvc> setconf to the first WLAN in the list regardless of id (Oct 12 + Oct 17 incidents). Use addobj (create), updobj (by id), or delobj (by id).',
		)
	}
	if (action !== 'addobj' && action !== 'updobj' && action !== 'delobj') {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing WLAN write with action "${action}". Only addobj, updobj, and delobj are allowed.`,
		)
	}
	if (/<wlansvc-list[\s>/]/i.test(xmlBody)) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			'Refusing WLAN write that wraps <wlansvc-list>; send a single <wlansvc>.',
		)
	}
	if (countTopLevelWlansvcElements(xmlBody) !== 1) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			'Refusing WLAN write: the body must contain exactly one <wlansvc> element.',
		)
	}
	const openTag = /<wlansvc(?=[\s>/])[^>]*>/i.exec(xmlBody)?.[0] ?? ''
	const id = getAttributeValue(openTag, 'id')
	if (action === 'addobj') {
		if (id !== null) {
			throw new AccessNetworksUnleashedWlanWriteRefusedError(
				'Refusing addobj with an id attribute: the controller assigns ids on create.',
			)
		}
		return
	}
	if (!id || !id.trim()) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing ${action} without an explicit wlansvc id. A WLAN write with no target id is never sent.`,
		)
	}
}

async function sendWlanWrite(
	client: AccessNetworksUnleashedClient,
	action: WlanWriteAction,
	xmlBody: string,
) {
	assertTargetedWlanWrite(action, xmlBody)
	try {
		return await client.request({ action, comp: wlanListComp, xmlBody })
	} catch (error) {
		// Controller error text can echo the payload (including secrets).
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(redactSecretsInXmlText(message), { cause: error })
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Read wlansvc-list without throwing on content. Id-less and duplicate-id
 * entries are reported (not fatal) so reads keep working on a damaged list.
 */
export async function readWlanList(
	client: AccessNetworksUnleashedClient,
	options?: { decryptSecrets?: boolean },
): Promise<WlanListRead> {
	const result = await client.request({
		action: 'getconf',
		comp: wlanListComp,
		xmlBody: '',
		...(options?.decryptSecrets ? { decryptSecrets: true } : {}),
	})
	const parsed = parseWlansvcList(result.xml)
	return { xml: result.xml, ...parsed }
}

export function describeWlanListDamage(read: {
	anomalies: Array<WlanListAnomaly>
	duplicateIds: Array<string>
}): Array<string> {
	const problems: Array<string> = []
	for (const anomaly of read.anomalies) {
		problems.push(
			`wlansvc at list position ${String(anomaly.index)} (name "${anomaly.name ?? '?'}", ssid "${anomaly.ssid ?? '?'}") has no id`,
		)
	}
	if (read.duplicateIds.length > 0) {
		problems.push(`duplicate wlansvc id(s): ${read.duplicateIds.join(', ')}`)
	}
	return problems
}

export async function getWlanById(
	client: AccessNetworksUnleashedClient,
	id: string,
): Promise<{ list: WlanListRead; wlan: WlanSvcEntry }> {
	const targetId = id.trim()
	if (!targetId) {
		throw new Error('WLAN id must not be empty.')
	}
	const list = await readWlanList(client)
	if (list.duplicateIds.includes(targetId)) {
		throw new Error(
			`WLAN id "${targetId}" appears more than once in wlansvc-list; the list is damaged. Repair it in the Unleashed UI.`,
		)
	}
	const wlan = indexWlansById(list.entries).get(targetId)
	if (!wlan) {
		throw new Error(
			`WLAN id "${targetId}" was not found in wlansvc-list. Known ids: ${list.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}
	return { list, wlan }
}

/**
 * Read-only: report whether a write could be snapshotted and fully rolled
 * back right now (clean list + every PSK WLAN's secret captured), without
 * returning any secret.
 */
export async function checkWlanWriteReadiness(
	client: AccessNetworksUnleashedClient,
): Promise<{
	ready: boolean
	problems: Array<string>
	wlans: Array<{
		id: string | null
		name: string | null
		restorable: boolean
		problems: Array<string>
	}>
}> {
	const read = await readWlanList(client, { decryptSecrets: true })
	const problems = describeWlanListDamage(read)
	const wlans: Array<{
		id: string | null
		name: string | null
		restorable: boolean
		problems: Array<string>
	}> = []
	for (const entry of read.entries) {
		const secretProblems = findUnrestorableSecrets(entry)
		wlans.push({
			id: entry.id,
			name: entry.name,
			restorable: secretProblems.length === 0,
			problems: secretProblems,
		})
		for (const problem of secretProblems) {
			problems.push(`WLAN id "${entry.id}" (${entry.name ?? '?'}): ${problem}`)
		}
	}
	for (const anomaly of read.anomalies) {
		wlans.push({
			id: null,
			name: anomaly.name,
			restorable: false,
			problems: ['no id'],
		})
	}
	const stability = await readWlanList(client, { decryptSecrets: true })
	if (!snapshotsEquivalent(read.entries, stability.entries)) {
		problems.push(
			'two consecutive getconf reads of wlansvc-list differ; config is changing or not stable to compare',
		)
	}
	return { ready: problems.length === 0, problems, wlans }
}

function snapshotsEquivalent(
	a: Array<WlanSvcEntry>,
	b: Array<WlanSvcEntry>,
): boolean {
	if (a.length !== b.length) return false
	const bById = indexWlansById(b)
	for (const entry of a) {
		const other = bById.get(entry.id)
		if (!other) return false
		if (
			canonicalWlanFingerprint(entry.rawXml) !==
			canonicalWlanFingerprint(other.rawXml)
		) {
			return false
		}
	}
	return true
}

/**
 * Take the pre-write snapshot. Refuses (throws before any write) unless the
 * list is clean, every PSK WLAN's passphrase was captured (DECRYPT_X), and
 * two consecutive reads agree (so post-write diffs are meaningful).
 */
export async function takeRestorableSnapshot(
	client: AccessNetworksUnleashedClient,
	options: WlanWriteOptions = {},
): Promise<WlanSnapshot> {
	const first = await readWlanList(client, { decryptSecrets: true })
	const damage = describeWlanListDamage(first)
	if (damage.length > 0) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing WLAN write: wlansvc-list is damaged (${damage.join('; ')}). Nothing was sent. Reads still work; repair the list in the Unleashed web UI (delete/recreate the affected WLAN) and retry.`,
		)
	}
	const secretProblems: Array<string> = []
	const unrestorableIds: Array<string> = []
	for (const entry of first.entries) {
		const problems = findUnrestorableSecrets(entry)
		if (problems.length > 0) unrestorableIds.push(entry.id)
		for (const problem of problems) {
			secretProblems.push(`id "${entry.id}" (${entry.name ?? '?'}): ${problem}`)
		}
	}
	if (
		secretProblems.length > 0 &&
		options.acceptUnrestorablePassphrases !== true
	) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing WLAN write: a fully restorable snapshot is not possible (${secretProblems.join('; ')}). Nothing was sent. Pass acceptUnrestorablePassphrases: true only if losing the ability to auto-restore those passphrases is acceptable.`,
		)
	}
	const second = await readWlanList(client, { decryptSecrets: true })
	if (
		describeWlanListDamage(second).length > 0 ||
		!snapshotsEquivalent(first.entries, second.entries)
	) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			'Refusing WLAN write: two consecutive reads of wlansvc-list differ, so a post-write diff would not be trustworthy. Nothing was sent.',
		)
	}
	return { entries: first.entries, unrestorableIds }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function extractCreatedIdFromResponse(xml: string): string | null {
	const parsed = parseWlansvcList(xml)
	const ids = parsed.entries.map((entry) => entry.id)
	return ids.length === 1 ? (ids[0] ?? null) : null
}

function errorText(error: unknown) {
	return redactSecretsInXmlText(
		error instanceof Error ? error.message : String(error),
	)
}

/**
 * Restore the snapshot using only id-targeted object actions. Never throws:
 * returns a report of what was restored and what needs manual repair.
 *
 * - WLANs present by a unique id but changed → `updobj` with the full
 *   snapshot object (id included, secrets included).
 * - WLANs missing → `addobj` of the snapshot object without id (the
 *   controller assigns a new id; reported in `reassignedIds`).
 * - Unique ids not in the snapshot → `delobj` by id.
 * - Id-less or duplicate-id entries cannot be targeted safely by any action,
 *   so they are reported as unresolved instead of guessed at.
 */
export async function restoreWlanSnapshot(
	client: AccessNetworksUnleashedClient,
	snapshot: WlanSnapshot,
): Promise<WlanRestoreReport> {
	const actions: Array<WlanRestoreAction> = []
	const unresolved: Array<string> = []
	const reassignedIds: Record<string, string> = {}

	let current: WlanListRead
	try {
		current = await readWlanList(client, { decryptSecrets: true })
	} catch (error) {
		return {
			status: 'failed',
			actions,
			unresolved: [
				`could not read wlansvc-list to restore: ${errorText(error)}`,
			],
			reassignedIds,
		}
	}

	const duplicateIds = new Set(current.duplicateIds)
	const snapshotIds = new Set(snapshot.entries.map((entry) => entry.id))
	const currentById = indexWlansById(current.entries)

	// 1. Remove WLANs that were not in the snapshot (unique ids only).
	const seenExtras = new Set<string>()
	for (const entry of current.entries) {
		if (snapshotIds.has(entry.id) || seenExtras.has(entry.id)) continue
		seenExtras.add(entry.id)
		if (duplicateIds.has(entry.id)) {
			unresolved.push(
				`id "${entry.id}" (${entry.name ?? '?'}) is not in the snapshot and is duplicated; delete it manually`,
			)
			continue
		}
		try {
			await sendWlanWrite(
				client,
				'delobj',
				`<wlansvc id='${escapeXmlAttribute(entry.id)}'/>`,
			)
			actions.push({ op: 'delobj', id: entry.id, name: entry.name, ok: true })
		} catch (error) {
			actions.push({
				op: 'delobj',
				id: entry.id,
				name: entry.name,
				ok: false,
				error: errorText(error),
			})
		}
	}

	// 2. Put every snapshot WLAN back.
	const unrestorable = new Set(snapshot.unrestorableIds)
	for (const entry of snapshot.entries) {
		if (duplicateIds.has(entry.id)) {
			unresolved.push(
				`id "${entry.id}" (${entry.name ?? '?'}) appears more than once; it cannot be targeted safely, repair manually`,
			)
			continue
		}
		const live = currentById.get(entry.id)
		if (live) {
			if (
				canonicalWlanFingerprint(live.rawXml) ===
				canonicalWlanFingerprint(entry.rawXml)
			) {
				continue
			}
			try {
				// Without a captured passphrase a full-object write could clear
				// the PSK, so only root attributes are restored for those.
				const restoreXml = unrestorable.has(entry.id)
					? buildPartialWlanUpdateXml({
							id: entry.id,
							attributes: Object.fromEntries(
								Object.entries(entry.attributes).filter(
									([name]) => name !== 'id' && !isSecretWlanAttributeName(name),
								),
							),
						})
					: entry.rawXml
				await sendWlanWrite(client, 'updobj', restoreXml)
				actions.push({ op: 'updobj', id: entry.id, name: entry.name, ok: true })
			} catch (error) {
				actions.push({
					op: 'updobj',
					id: entry.id,
					name: entry.name,
					ok: false,
					error: errorText(error),
				})
			}
			continue
		}
		if (unrestorable.has(entry.id)) {
			unresolved.push(
				`WLAN id "${entry.id}" (${entry.name ?? '?'}) is missing and its passphrase was not captured; re-create it manually in the Unleashed web UI`,
			)
			continue
		}
		try {
			const response = await sendWlanWrite(
				client,
				'addobj',
				removeRootAttributes(entry.rawXml, controllerOwnedRootAttributes),
			)
			const newId = extractCreatedIdFromResponse(response.xml)
			actions.push({
				op: 'addobj',
				id: entry.id,
				name: entry.name,
				ok: true,
				newId,
			})
		} catch (error) {
			actions.push({
				op: 'addobj',
				id: entry.id,
				name: entry.name,
				ok: false,
				error: errorText(error),
			})
		}
	}

	for (const anomaly of current.anomalies) {
		unresolved.push(
			`wlansvc at list position ${String(anomaly.index)} (name "${anomaly.name ?? '?'}") has no id; no Unleashed action can target it. Delete it in the Unleashed web UI`,
		)
	}

	// 3. Verify.
	let verify: WlanListRead
	try {
		verify = await readWlanList(client, { decryptSecrets: true })
	} catch (error) {
		unresolved.push(
			`could not re-read wlansvc-list after restore: ${errorText(error)}`,
		)
		return {
			status: actions.some((action) => action.ok) ? 'partial' : 'failed',
			actions,
			unresolved,
			reassignedIds,
		}
	}
	const verifyById = indexWlansById(verify.entries)
	const claimed = new Set<string>()
	for (const entry of snapshot.entries) {
		const sameId = verifyById.get(entry.id)
		if (
			sameId &&
			!verify.duplicateIds.includes(entry.id) &&
			canonicalWlanFingerprint(sameId.rawXml) ===
				canonicalWlanFingerprint(entry.rawXml)
		) {
			claimed.add(entry.id)
			continue
		}
		// Re-created via addobj: match a new id with identical content.
		const recreated = verify.entries.find(
			(candidate) =>
				!snapshotIds.has(candidate.id) &&
				!claimed.has(candidate.id) &&
				wlanXmlContainsExpected({
					expectedXml: removeRootAttributes(
						entry.rawXml,
						controllerOwnedRootAttributes,
					),
					actualXml: candidate.rawXml,
					ignoreRootAttributes: controllerOwnedRootAttributes,
				}).ok,
		)
		if (recreated) {
			claimed.add(recreated.id)
			reassignedIds[entry.id] = recreated.id
			continue
		}
		unresolved.push(
			`WLAN id "${entry.id}" (${entry.name ?? '?'}) does not match the snapshot after restore`,
		)
	}
	for (const entry of verify.entries) {
		if (!snapshotIds.has(entry.id) && !claimed.has(entry.id)) {
			unresolved.push(
				`unexpected WLAN id "${entry.id}" (${entry.name ?? '?'}) is still present after restore`,
			)
		}
	}
	for (const problem of describeWlanListDamage(verify)) {
		const message = `after restore: ${problem}`
		if (!unresolved.includes(message)) unresolved.push(message)
	}

	const dedupedUnresolved = [...new Set(unresolved)]
	let status: WlanRestoreReport['status']
	if (dedupedUnresolved.length === 0) {
		status = actions.length === 0 ? 'not-needed' : 'restored'
	} else {
		status = actions.some((action) => action.ok) ? 'partial' : 'failed'
	}
	return { status, actions, unresolved: dedupedUnresolved, reassignedIds }
}

// ---------------------------------------------------------------------------
// Verify-or-rollback
// ---------------------------------------------------------------------------

type VerifyExpectation = {
	/** Ids allowed to change content. */
	allowedChangedIds: ReadonlySet<string>
	/** Ids allowed (required) to disappear. */
	expectedRemovedIds: ReadonlySet<string>
	/** How many brand-new ids must appear (0 or 1). */
	expectedAddedCount: number
	/** Extra checks on the post-write list; return problems (no secrets). */
	check?: (after: WlanListRead, addedIds: Array<string>) => Array<string>
}

function diffAgainstSnapshot(
	snapshot: WlanSnapshot,
	after: WlanListRead,
	expectation: VerifyExpectation,
): { problems: Array<string>; addedIds: Array<string> } {
	const problems = describeWlanListDamage(after)
	const afterById = indexWlansById(after.entries)
	const snapshotIds = new Set(snapshot.entries.map((entry) => entry.id))
	for (const entry of snapshot.entries) {
		const live = afterById.get(entry.id)
		if (expectation.expectedRemovedIds.has(entry.id)) {
			if (live)
				problems.push(
					`WLAN id "${entry.id}" was expected to be removed but is still present`,
				)
			continue
		}
		if (!live) {
			problems.push(`WLAN id "${entry.id}" (${entry.name ?? '?'}) is missing`)
			continue
		}
		if (expectation.allowedChangedIds.has(entry.id)) continue
		if (
			canonicalWlanFingerprint(live.rawXml) !==
			canonicalWlanFingerprint(entry.rawXml)
		) {
			problems.push(
				`unexpected change to WLAN id "${entry.id}" (${entry.name ?? '?'})`,
			)
		}
	}
	const addedIds = [
		...new Set(
			after.entries
				.map((entry) => entry.id)
				.filter((id) => !snapshotIds.has(id)),
		),
	]
	if (addedIds.length !== expectation.expectedAddedCount) {
		problems.push(
			expectation.expectedAddedCount === 0
				? `unexpected new WLAN id(s): ${addedIds.join(', ')}`
				: `expected exactly ${String(expectation.expectedAddedCount)} new WLAN id but found ${String(addedIds.length)}${addedIds.length ? ` (${addedIds.join(', ')})` : ''}`,
		)
	}
	return { problems, addedIds }
}

/**
 * Re-read after a write and roll back on ANY anomaly. Rollback always runs
 * before any error is raised: a damaged post-write list (id-less entry,
 * duplicate ids, failed re-read, failed write request) is a reason to
 * restore, never a reason to stop.
 */
async function verifyOrRollback(input: {
	client: AccessNetworksUnleashedClient
	snapshot: WlanSnapshot
	expectation: VerifyExpectation
	writeError: unknown
}): Promise<{
	after: WlanListRead
	addedIds: Array<string>
	safety: WlanWriteSafetyResult
}> {
	const problems: Array<string> = []
	if (input.writeError !== null && input.writeError !== undefined) {
		problems.push(`write request failed: ${errorText(input.writeError)}`)
	}
	let after: WlanListRead | null = null
	try {
		after = await readWlanList(input.client, { decryptSecrets: true })
	} catch (error) {
		problems.push(
			`could not re-read wlansvc-list after write: ${errorText(error)}`,
		)
	}
	let addedIds: Array<string> = []
	if (after) {
		const diff = diffAgainstSnapshot(input.snapshot, after, input.expectation)
		addedIds = diff.addedIds
		problems.push(...diff.problems)
		if (problems.length === 0 && input.expectation.check) {
			try {
				problems.push(...input.expectation.check(after, addedIds))
			} catch (error) {
				problems.push(errorText(error))
			}
		}
	}

	if (problems.length === 0 && after) {
		return {
			after,
			addedIds,
			safety: {
				rolledBack: false,
				problems: [],
				snapshotEntryCount: input.snapshot.entries.length,
				afterEntryCount: after.entries.length + after.anomalies.length,
				restore: null,
			},
		}
	}

	const restore = await restoreWlanSnapshot(input.client, input.snapshot)
	const safety: WlanWriteSafetyResult = {
		rolledBack:
			restore.status === 'restored' || restore.status === 'not-needed',
		problems,
		snapshotEntryCount: input.snapshot.entries.length,
		afterEntryCount: after
			? after.entries.length + after.anomalies.length
			: null,
		restore,
	}
	const restoreSummary =
		restore.status === 'restored' || restore.status === 'not-needed'
			? `Automatically rolled back to the pre-write WLAN snapshot${
					Object.keys(restore.reassignedIds).length
						? ` (re-created ids: ${Object.entries(restore.reassignedIds)
								.map(([from, to]) => `${from}→${to}`)
								.join(', ')})`
						: ''
				}.`
			: `Automatic rollback was ${restore.status.toUpperCase()}; manual repair needed: ${restore.unresolved.join('; ')}.`
	throw new AccessNetworksUnleashedWlanSafetyError(
		`WLAN write safety check failed: ${problems.join('; ')}. ${restoreSummary}`,
		safety,
	)
}

// ---------------------------------------------------------------------------
// Standard template (create baseline)
// ---------------------------------------------------------------------------

export const wlanStandardTemplateComp = 'wlansvc-standard-template'

async function fetchStandardWlanTemplate(
	client: AccessNetworksUnleashedClient,
): Promise<string> {
	let xml: string
	try {
		const result = await client.request({
			action: 'getconf',
			comp: wlanStandardTemplateComp,
			xmlBody: '',
			decryptSecrets: true,
		})
		xml = result.xml
	} catch (error) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing clone: could not read ${wlanStandardTemplateComp} (${errorText(error)}). Nothing was sent.`,
		)
	}
	const match =
		/<wlansvc(?=[\s>/])[\s\S]*?<\/wlansvc>|<wlansvc(?=[\s>/])[^>]*\/>/i.exec(
			xml,
		)
	if (!match) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing clone: ${wlanStandardTemplateComp} returned no <wlansvc>. Nothing was sent.`,
		)
	}
	return match[0]
}

type MergeElement = {
	name: string
	attributes: Array<[string, string]>
	children: Array<MergeElement>
}

function parseMergeElement(xml: string): MergeElement | null {
	const tagRegex = /<(\/?)([\w:-]+)([^>]*?)(\/?)>/g
	const stack: Array<MergeElement> = []
	let root: MergeElement | null = null
	for (const match of xml.matchAll(tagRegex)) {
		if (match[1] === '/') {
			stack.pop()
			continue
		}
		const attrText = match[3] ?? ''
		const attributes: Array<[string, string]> = []
		for (const attr of attrText.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
			attributes.push([attr[1] ?? '', attr[3] ?? ''])
		}
		const element: MergeElement = {
			name: match[2] ?? '',
			attributes,
			children: [],
		}
		const parent = stack[stack.length - 1]
		if (parent) parent.children.push(element)
		else if (!root) root = element
		if (match[4] !== '/') stack.push(element)
	}
	return root
}

function mergeElements(
	template: MergeElement,
	source: MergeElement,
): MergeElement {
	const attributes: Array<[string, string]> = []
	const sourceAttrs = new Map(source.attributes)
	const seen = new Set<string>()
	for (const [name, value] of template.attributes) {
		attributes.push([
			name,
			sourceAttrs.has(name) ? (sourceAttrs.get(name) ?? '') : value,
		])
		seen.add(name)
	}
	for (const [name, value] of source.attributes) {
		if (!seen.has(name)) attributes.push([name, value])
	}
	const children: Array<MergeElement> = []
	const sourceChildren = [...source.children]
	for (const templateChild of template.children) {
		const index = sourceChildren.findIndex(
			(child) => child.name === templateChild.name,
		)
		if (index >= 0) {
			const [sourceChild] = sourceChildren.splice(index, 1)
			children.push(mergeElements(templateChild, sourceChild!))
		} else {
			children.push(templateChild)
		}
	}
	children.push(...sourceChildren)
	return { name: template.name, attributes, children }
}

function serializeMergeElement(element: MergeElement): string {
	const attrs = element.attributes
		.map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
		.join('')
	if (element.children.length === 0) return `<${element.name}${attrs}/>`
	return `<${element.name}${attrs}>${element.children.map(serializeMergeElement).join('')}</${element.name}>`
}

/**
 * aioruckus do_clone_wlan: template first, then the source's attributes and
 * children on top (source wins). Values are decoded and re-escaped.
 */
export function mergeWlanOntoTemplate(input: {
	templateXml: string
	sourceXml: string
}): string {
	const template = parseMergeElement(input.templateXml)
	const source = parseMergeElement(input.sourceXml)
	if (!template || !source) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			'Refusing clone: could not parse the WLAN template or source.',
		)
	}
	const decode = (element: MergeElement): MergeElement => ({
		...element,
		attributes: element.attributes.map(([name, value]) => [
			name,
			decodeXmlEntities(value),
		]),
		children: element.children.map(decode),
	})
	return serializeMergeElement(mergeElements(decode(template), decode(source)))
}

// ---------------------------------------------------------------------------
// Public write operations
// ---------------------------------------------------------------------------

export async function updateWlanById(
	input: {
		client: AccessNetworksUnleashedClient
		id: string
		attributes: Record<string, string>
	} & WlanWriteOptions,
): Promise<{
	id: string
	before: WlanSvcEntry
	after: WlanSvcEntry | null
	appliedAttributes: Record<string, string>
	safety: WlanWriteSafetyResult | null
	requestAction: 'updobj'
	requestXml: string
	requests: Array<WlanPlannedRequest>
	dryRun: boolean
}> {
	const targetId = input.id.trim()
	if (!targetId) throw new Error('WLAN id must not be empty.')
	const appliedAttributes = { ...input.attributes }
	if (Object.keys(appliedAttributes).length === 0) {
		throw new Error('updateWlanById requires at least one attribute to change.')
	}

	const snapshot = await takeRestorableSnapshot(input.client, input)
	const before = indexWlansById(snapshot.entries).get(targetId)
	if (!before) {
		throw new Error(
			`WLAN id "${targetId}" was not found before update. Known ids: ${snapshot.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}
	assertWritableAttributes({
		attributes: appliedAttributes,
		element: before,
		context: `update of WLAN id "${targetId}"`,
	})

	// aioruckus do_disable_wlan: updobj + id + IS_PARTIAL on wlansvc-list.
	const requestXml = buildPartialWlanUpdateXml({
		id: targetId,
		attributes: appliedAttributes,
	})
	const requests: Array<WlanPlannedRequest> = [
		{ action: 'updobj', comp: wlanListComp, xmlBody: requestXml },
	]
	if (input.dryRun === true) {
		return {
			id: targetId,
			before,
			after: null,
			appliedAttributes,
			safety: null,
			requestAction: 'updobj',
			requestXml,
			requests,
			dryRun: true,
		}
	}

	let writeError: unknown = null
	try {
		await sendWlanWrite(input.client, 'updobj', requestXml)
	} catch (error) {
		if (error instanceof AccessNetworksUnleashedWlanWriteRefusedError)
			throw error
		writeError = error
	}

	const expectedXml = applyWlanAttributeOverrides(
		before.rawXml,
		appliedAttributes,
	)
	const { after: afterList, safety } = await verifyOrRollback({
		client: input.client,
		snapshot,
		writeError,
		expectation: {
			allowedChangedIds: new Set([targetId]),
			expectedRemovedIds: new Set(),
			expectedAddedCount: 0,
			check: (after) => {
				const updated = indexWlansById(after.entries).get(targetId)
				if (!updated) return [`WLAN id "${targetId}" was missing after update`]
				if (
					canonicalWlanFingerprint(updated.rawXml) !==
					canonicalWlanFingerprint(expectedXml)
				) {
					const detail = wlanXmlContainsExpected({
						expectedXml,
						actualXml: updated.rawXml,
					})
					return [
						`WLAN id "${targetId}" changed beyond the requested attributes${detail.ok ? '' : ` (${detail.mismatch})`}`,
					]
				}
				return []
			},
		},
	})

	const after = indexWlansById(afterList.entries).get(targetId)
	if (!after) {
		throw new Error(
			`WLAN id "${targetId}" was missing after a successful safety check.`,
		)
	}
	return {
		id: targetId,
		before,
		after,
		appliedAttributes,
		safety,
		requestAction: 'updobj',
		requestXml,
		requests,
		dryRun: false,
	}
}

export async function cloneWlanById(
	input: {
		client: AccessNetworksUnleashedClient
		sourceId: string
		overrides?: WlanAttributeOverrides
	} & WlanWriteOptions,
): Promise<{
	sourceId: string
	source: WlanSvcEntry
	created: WlanSvcEntry | null
	overridesApplied: Record<string, string>
	safety: WlanWriteSafetyResult | null
	requestAction: 'addobj'
	/** Create payload with secrets redacted. */
	requestXml: string
	requests: Array<WlanPlannedRequest>
	warnings: Array<string>
	dryRun: boolean
}> {
	const sourceId = input.sourceId.trim()
	if (!sourceId) throw new Error('source WLAN id must not be empty.')

	const overridesApplied = resolveWlanAttributeOverrides(input.overrides ?? {})
	const snapshot = await takeRestorableSnapshot(input.client, input)
	const source = indexWlansById(snapshot.entries).get(sourceId)
	if (!source) {
		throw new Error(
			`Source WLAN id "${sourceId}" was not found. Known ids: ${snapshot.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}
	if (snapshot.unrestorableIds.includes(sourceId)) {
		// A clone without the passphrase would be a WPA WLAN with no PSK;
		// Unleashed does not validate config and can crash-loop on that.
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing clone: the passphrase of source WLAN id "${sourceId}" could not be captured, so the copy would have no PSK. Nothing was sent.`,
		)
	}
	assertWritableAttributes({
		attributes: overridesApplied,
		element: source,
		context: `clone of WLAN id "${sourceId}"`,
	})
	const newName = overridesApplied['name'] ?? source.name
	const newSsid = overridesApplied['ssid'] ?? source.ssid
	for (const entry of snapshot.entries) {
		if (entry.name && entry.name === newName) {
			throw new AccessNetworksUnleashedWlanWriteRefusedError(
				`Refusing clone: a WLAN named "${newName}" already exists (id "${entry.id}"). Pass a new name.`,
			)
		}
		if (entry.ssid && entry.ssid === newSsid) {
			throw new AccessNetworksUnleashedWlanWriteRefusedError(
				`Refusing clone: SSID "${newSsid}" is already used by WLAN id "${entry.id}". Pass a new ssid.`,
			)
		}
	}

	const warnings: Array<string> = []
	const guestServiceId = source.attributes['guestservice-id']
	if (guestServiceId) {
		warnings.push(
			`The clone references the source's guestservice-id "${guestServiceId}". The Unleashed UI creates a dedicated guest service per WLAN; whether deleting either WLAN later also removes that shared guest service is unverified.`,
		)
	}

	// Unleashed web UI / CommScope Postman / aioruckus / ruckus-go create via
	// addobj on wlansvc-list with no id; the controller assigns one. Like
	// aioruckus do_clone_wlan, start from wlansvc-standard-template and lay
	// the source WLAN on top so template-only defaults are present.
	const template = await fetchStandardWlanTemplate(input.client)
	const createXml = applyWlanAttributeOverrides(
		mergeWlanOntoTemplate({
			templateXml: template,
			sourceXml: removeRootAttributes(
				source.rawXml,
				controllerOwnedRootAttributes,
			),
		}),
		overridesApplied,
	)
	if (
		getAttributeValue(/^<wlansvc[^>]*>/i.exec(createXml)?.[0] ?? '', 'id') !==
		null
	) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			'Refusing clone: the create payload still carries an id.',
		)
	}
	const requestXml = redactSecretsInXmlText(createXml)
	const requests: Array<WlanPlannedRequest> = [
		{ action: 'addobj', comp: wlanListComp, xmlBody: requestXml },
	]
	if (input.dryRun === true) {
		return {
			sourceId,
			source,
			created: null,
			overridesApplied,
			safety: null,
			requestAction: 'addobj',
			requestXml,
			requests,
			warnings,
			dryRun: true,
		}
	}

	let writeError: unknown = null
	try {
		await sendWlanWrite(input.client, 'addobj', createXml)
	} catch (error) {
		if (error instanceof AccessNetworksUnleashedWlanWriteRefusedError)
			throw error
		writeError = error
	}

	const {
		after: afterList,
		addedIds,
		safety,
	} = await verifyOrRollback({
		client: input.client,
		snapshot,
		writeError,
		expectation: {
			allowedChangedIds: new Set(),
			expectedRemovedIds: new Set(),
			expectedAddedCount: 1,
			check: (after, added) => {
				const created = indexWlansById(after.entries).get(added[0] ?? '')
				if (!created) return ['cloned WLAN could not be located after create']
				const contains = wlanXmlContainsExpected({
					expectedXml: createXml,
					actualXml: created.rawXml,
					ignoreRootAttributes: controllerOwnedRootAttributes,
				})
				return contains.ok
					? []
					: [
							`cloned WLAN id "${created.id}" does not match the create payload: ${contains.mismatch}`,
						]
			},
		},
	})

	const created = indexWlansById(afterList.entries).get(addedIds[0] ?? '')
	if (!created) {
		throw new Error('Cloned WLAN missing after a successful safety check.')
	}
	return {
		sourceId,
		source,
		created,
		overridesApplied,
		safety,
		requestAction: 'addobj',
		requestXml,
		requests,
		warnings,
		dryRun: false,
	}
}

export async function deleteWlanById(
	input: {
		client: AccessNetworksUnleashedClient
		id: string
		/** Must equal the target's current name; guards against a wrong id. */
		expectedName: string
	} & WlanWriteOptions,
): Promise<{
	id: string
	deleted: WlanSvcEntry
	safety: WlanWriteSafetyResult | null
	requestAction: 'delobj'
	requestXml: string
	requests: Array<WlanPlannedRequest>
	warnings: Array<string>
	dryRun: boolean
}> {
	const targetId = input.id.trim()
	if (!targetId) throw new Error('WLAN id must not be empty.')
	const snapshot = await takeRestorableSnapshot(input.client, input)
	const target = indexWlansById(snapshot.entries).get(targetId)
	if (!target) {
		throw new Error(
			`WLAN id "${targetId}" was not found. Known ids: ${snapshot.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}
	if (target.name !== input.expectedName) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			`Refusing delete: WLAN id "${targetId}" is named "${target.name ?? '?'}", not "${input.expectedName}".`,
		)
	}
	const warnings: Array<string> = []
	const guestServiceId = target.attributes['guestservice-id']
	const sharers = snapshot.entries.filter(
		(entry) =>
			entry.id !== targetId &&
			guestServiceId &&
			entry.attributes['guestservice-id'] === guestServiceId,
	)
	if (sharers.length > 0) {
		warnings.push(
			`guestservice-id "${guestServiceId}" is shared with WLAN id(s) ${sharers.map((entry) => entry.id).join(', ')}; check guestservice-list after delete.`,
		)
	}

	// aioruckus do_delete_wlan / ruckus-go Delete: delobj with only the id.
	const requestXml = `<wlansvc id='${escapeXmlAttribute(targetId)}'/>`
	const requests: Array<WlanPlannedRequest> = [
		{ action: 'delobj', comp: wlanListComp, xmlBody: requestXml },
	]
	if (input.dryRun === true) {
		return {
			id: targetId,
			deleted: target,
			safety: null,
			requestAction: 'delobj',
			requestXml,
			requests,
			warnings,
			dryRun: true,
		}
	}

	let writeError: unknown = null
	try {
		await sendWlanWrite(input.client, 'delobj', requestXml)
	} catch (error) {
		if (error instanceof AccessNetworksUnleashedWlanWriteRefusedError)
			throw error
		writeError = error
	}
	const { safety } = await verifyOrRollback({
		client: input.client,
		snapshot,
		writeError,
		expectation: {
			allowedChangedIds: new Set(),
			expectedRemovedIds: new Set([targetId]),
			expectedAddedCount: 0,
		},
	})
	return {
		id: targetId,
		deleted: target,
		safety,
		requestAction: 'delobj',
		requestXml,
		requests,
		warnings,
		dryRun: false,
	}
}
