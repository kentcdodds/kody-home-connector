import { type AccessNetworksUnleashedClient } from './types.ts'
import {
	applyWlanAttributeOverrides,
	buildPartialWlanUpdateXml,
	diffWlanLists,
	escapeXmlAttribute,
	extractWlansvcEntries,
	findDuplicateIds,
	getAttributeValue,
	indexWlansById,
	removeRootIdAttribute,
	type WlanListDiff,
	type WlanSvcEntry,
} from './wlan-xml.ts'

export const wlanListComp = 'wlansvc-list'

export type WlanRadioBand = 'all' | '2.4ghz' | '5ghz' | '6ghz'

export type WlanAttributeOverrides = {
	name?: string
	ssid?: string
	description?: string
	vlanId?: string | number
	clientIsolation?: string
	/**
	 * Radio band restriction when the controller stores it on the wlansvc as
	 * the `radio` attribute (Both / 2.4G / 5G / 6G). Prefer reading the source
	 * WLAN first; use `attributes` for any other exact Unleashed attribute.
	 */
	radioBand?: WlanRadioBand
	/** Exact Unleashed wlansvc attribute names → values. */
	attributes?: Record<string, string>
}

export type WlanSnapshot = {
	xml: string
	entries: Array<WlanSvcEntry>
}

export type WlanWriteSafetyResult = {
	rolledBack: boolean
	diff: WlanListDiff
	snapshotEntryCount: number
	afterEntryCount: number
}

export class AccessNetworksUnleashedWlanSafetyError extends Error {
	readonly safety: WlanWriteSafetyResult

	constructor(message: string, safety: WlanWriteSafetyResult) {
		super(message)
		this.name = 'AccessNetworksUnleashedWlanSafetyError'
		this.safety = safety
	}
}

const radioBandToAttribute: Record<WlanRadioBand, string> = {
	all: 'Both',
	'2.4ghz': '2.4G',
	'5ghz': '5G',
	'6ghz': '6G',
}

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
		attributes['radio'] = radioBandToAttribute[overrides.radioBand]
	}
	return attributes
}

export async function fetchWlanSnapshot(
	client: AccessNetworksUnleashedClient,
): Promise<WlanSnapshot> {
	const result = await client.request({
		action: 'getconf',
		comp: wlanListComp,
		xmlBody: '',
	})
	const entries = extractWlansvcEntries(result.xml)
	const duplicates = findDuplicateIds(entries)
	if (duplicates.length > 0) {
		throw new Error(
			`Access Networks Unleashed wlansvc-list already has duplicate id(s): ${duplicates.join(', ')}. Refuse to proceed until the controller config is repaired.`,
		)
	}
	return { xml: result.xml, entries }
}

export async function getWlanById(
	client: AccessNetworksUnleashedClient,
	id: string,
): Promise<{ snapshot: WlanSnapshot; wlan: WlanSvcEntry }> {
	const targetId = id.trim()
	if (!targetId) {
		throw new Error('WLAN id must not be empty.')
	}
	const snapshot = await fetchWlanSnapshot(client)
	const wlan = indexWlansById(snapshot.entries).get(targetId)
	if (!wlan) {
		throw new Error(
			`WLAN id "${targetId}" was not found in wlansvc-list. Known ids: ${snapshot.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}
	return { snapshot, wlan }
}

async function setconfWlan(
	client: AccessNetworksUnleashedClient,
	xmlBody: string,
) {
	return await client.request({
		action: 'setconf',
		comp: wlanListComp,
		xmlBody,
	})
}

async function deleteWlanById(
	client: AccessNetworksUnleashedClient,
	id: string,
) {
	await setconfWlan(
		client,
		`<wlansvc id='${escapeXmlAttribute(id)}' DELETE='true' IS_PARTIAL='true'/>`,
	)
}

/**
 * Restore every snapshot entry by id and delete any WLANs that were not in the
 * snapshot. Used after a failed safety check.
 */
export async function restoreWlanSnapshot(
	client: AccessNetworksUnleashedClient,
	snapshot: WlanSnapshot,
): Promise<void> {
	const current = await fetchWlanSnapshot(client).catch(async () => {
		// If the list is already corrupt (duplicate ids), fetchWlanSnapshot
		// throws. Fall back to a raw getconf so we can still delete extras and
		// rewrite known ids.
		const result = await client.request({
			action: 'getconf',
			comp: wlanListComp,
			xmlBody: '',
		})
		return {
			xml: result.xml,
			entries: extractWlansvcEntries(result.xml),
		}
	})
	const snapIds = new Set(snapshot.entries.map((entry) => entry.id))
	const seenCurrent = new Set<string>()
	for (const entry of current.entries) {
		if (seenCurrent.has(entry.id)) {
			// Duplicate id: delete extras after the first occurrence by rewriting
			// later via the snapshot restore of the canonical entry.
			await deleteWlanById(client, entry.id).catch(() => undefined)
			continue
		}
		seenCurrent.add(entry.id)
		if (!snapIds.has(entry.id)) {
			await deleteWlanById(client, entry.id)
		}
	}
	for (const entry of snapshot.entries) {
		await setconfWlan(client, entry.rawXml)
	}
}

async function verifyOrRollback(input: {
	client: AccessNetworksUnleashedClient
	snapshot: WlanSnapshot
	allowedChangedIds: ReadonlySet<string>
	allowedAddedIds: ReadonlySet<string>
	assertTarget?: (after: WlanSnapshot) => void
}): Promise<{ after: WlanSnapshot; safety: WlanWriteSafetyResult }> {
	const after = await fetchWlanSnapshot(input.client).catch((error) => {
		// Duplicate ids after write: treat as a failed safety check and roll back.
		if (error instanceof Error && /duplicate id/i.test(error.message)) {
			return null
		}
		throw error
	})

	if (after === null) {
		const corrupt = await input.client.request({
			action: 'getconf',
			comp: wlanListComp,
			xmlBody: '',
		})
		const corruptEntries = extractWlansvcEntries(corrupt.xml)
		const diff = diffWlanLists({
			before: input.snapshot.entries,
			after: corruptEntries,
			allowedChangedIds: input.allowedChangedIds,
			allowedAddedIds: input.allowedAddedIds,
		})
		// Force failure when duplicates exist even if diff missed them.
		diff.ok = false
		diff.duplicateIds = findDuplicateIds(corruptEntries)
		diff.summary = `WLAN list safety check failed: duplicate wlansvc id(s): ${diff.duplicateIds.join(', ') || 'unknown'}.`
		await restoreWlanSnapshot(input.client, input.snapshot)
		const safety: WlanWriteSafetyResult = {
			rolledBack: true,
			diff,
			snapshotEntryCount: input.snapshot.entries.length,
			afterEntryCount: corruptEntries.length,
		}
		throw new AccessNetworksUnleashedWlanSafetyError(
			`${diff.summary} Automatically rolled back to the pre-write WLAN snapshot.`,
			safety,
		)
	}

	const diff = diffWlanLists({
		before: input.snapshot.entries,
		after: after.entries,
		allowedChangedIds: input.allowedChangedIds,
		allowedAddedIds: input.allowedAddedIds,
	})

	try {
		if (diff.ok && input.assertTarget) {
			input.assertTarget(after)
		}
	} catch (error) {
		diff.ok = false
		diff.summary =
			error instanceof Error
				? `WLAN list safety check failed: ${error.message}`
				: 'WLAN list safety check failed after write.'
	}

	if (!diff.ok) {
		await restoreWlanSnapshot(input.client, input.snapshot)
		const safety: WlanWriteSafetyResult = {
			rolledBack: true,
			diff,
			snapshotEntryCount: input.snapshot.entries.length,
			afterEntryCount: after.entries.length,
		}
		throw new AccessNetworksUnleashedWlanSafetyError(
			`${diff.summary} Automatically rolled back to the pre-write WLAN snapshot.`,
			safety,
		)
	}

	return {
		after,
		safety: {
			rolledBack: false,
			diff,
			snapshotEntryCount: input.snapshot.entries.length,
			afterEntryCount: after.entries.length,
		},
	}
}

export async function updateWlanById(input: {
	client: AccessNetworksUnleashedClient
	id: string
	attributes: Record<string, string>
}): Promise<{
	id: string
	before: WlanSvcEntry
	after: WlanSvcEntry
	appliedAttributes: Record<string, string>
	safety: WlanWriteSafetyResult
	setconfXml: string
}> {
	const targetId = input.id.trim()
	if (!targetId) throw new Error('WLAN id must not be empty.')
	const appliedAttributes = { ...input.attributes }
	delete appliedAttributes['id']
	delete appliedAttributes['IS_PARTIAL']
	delete appliedAttributes['DELETE']
	if (Object.keys(appliedAttributes).length === 0) {
		throw new Error('updateWlanById requires at least one attribute to change.')
	}

	const snapshot = await fetchWlanSnapshot(input.client)
	const before = indexWlansById(snapshot.entries).get(targetId)
	if (!before) {
		throw new Error(
			`WLAN id "${targetId}" was not found before update. Known ids: ${snapshot.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}

	const setconfXml = buildPartialWlanUpdateXml({
		id: targetId,
		attributes: appliedAttributes,
	})
	await setconfWlan(input.client, setconfXml)

	const { after: afterSnapshot, safety } = await verifyOrRollback({
		client: input.client,
		snapshot,
		allowedChangedIds: new Set([targetId]),
		allowedAddedIds: new Set(),
		assertTarget: (after) => {
			const updated = indexWlansById(after.entries).get(targetId)
			if (!updated) {
				throw new Error(`WLAN id "${targetId}" was missing after update.`)
			}
			if (updated.id !== targetId) {
				throw new Error(
					`WLAN id mismatch after update: expected "${targetId}", got "${updated.id}".`,
				)
			}
			for (const [name, value] of Object.entries(appliedAttributes)) {
				const actual =
					updated.attributes[name] ?? getAttributeValue(updated.rawXml, name)
				if (actual !== value) {
					throw new Error(
						`WLAN id "${targetId}" attribute "${name}" expected "${value}" but found "${actual ?? '(missing)'}".`,
					)
				}
			}
		},
	})

	const after = indexWlansById(afterSnapshot.entries).get(targetId)
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
		setconfXml,
	}
}

export async function cloneWlanById(input: {
	client: AccessNetworksUnleashedClient
	sourceId: string
	overrides?: WlanAttributeOverrides
}): Promise<{
	sourceId: string
	source: WlanSvcEntry
	created: WlanSvcEntry
	overridesApplied: Record<string, string>
	safety: WlanWriteSafetyResult
	setconfXml: string
}> {
	const sourceId = input.sourceId.trim()
	if (!sourceId) throw new Error('source WLAN id must not be empty.')

	const snapshot = await fetchWlanSnapshot(input.client)
	const source = indexWlansById(snapshot.entries).get(sourceId)
	if (!source) {
		throw new Error(
			`Source WLAN id "${sourceId}" was not found. Known ids: ${snapshot.entries.map((entry) => entry.id).join(', ') || '(none)'}.`,
		)
	}

	const overridesApplied = resolveWlanAttributeOverrides(input.overrides ?? {})
	const withoutId = removeRootIdAttribute(source.rawXml)
	const setconfXml = applyWlanAttributeOverrides(withoutId, overridesApplied)
	if (getAttributeValue(setconfXml, 'id')) {
		throw new Error(
			'Refusing to clone a WLAN while an id attribute is still present on the create payload.',
		)
	}

	await setconfWlan(input.client, setconfXml)

	// Discover the new id: any id present after that was not in the snapshot.
	const afterProbe = await input.client.request({
		action: 'getconf',
		comp: wlanListComp,
		xmlBody: '',
	})
	const afterProbeEntries = extractWlansvcEntries(afterProbe.xml)
	const beforeIds = new Set(snapshot.entries.map((entry) => entry.id))
	const newIds = afterProbeEntries
		.map((entry) => entry.id)
		.filter((id) => !beforeIds.has(id))
	const uniqueNewIds = [...new Set(newIds)]

	if (uniqueNewIds.length !== 1) {
		const diff = diffWlanLists({
			before: snapshot.entries,
			after: afterProbeEntries,
			allowedChangedIds: new Set(),
			allowedAddedIds: new Set(uniqueNewIds),
		})
		diff.ok = false
		diff.summary =
			uniqueNewIds.length === 0
				? 'WLAN list safety check failed: clone did not create a new wlansvc id.'
				: `WLAN list safety check failed: clone created unexpected new id(s): ${uniqueNewIds.join(', ')}.`
		await restoreWlanSnapshot(input.client, snapshot)
		throw new AccessNetworksUnleashedWlanSafetyError(
			`${diff.summary} Automatically rolled back to the pre-write WLAN snapshot.`,
			{
				rolledBack: true,
				diff,
				snapshotEntryCount: snapshot.entries.length,
				afterEntryCount: afterProbeEntries.length,
			},
		)
	}

	const createdId = uniqueNewIds[0] as string
	const { after: afterSnapshot, safety } = await verifyOrRollback({
		client: input.client,
		snapshot,
		allowedChangedIds: new Set(),
		allowedAddedIds: new Set([createdId]),
		assertTarget: (after) => {
			const created = indexWlansById(after.entries).get(createdId)
			if (!created) {
				throw new Error(
					`Cloned WLAN id "${createdId}" was missing after create.`,
				)
			}
			for (const [name, value] of Object.entries(overridesApplied)) {
				const actual =
					created.attributes[name] ?? getAttributeValue(created.rawXml, name)
				if (actual !== value) {
					throw new Error(
						`Cloned WLAN id "${createdId}" attribute "${name}" expected "${value}" but found "${actual ?? '(missing)'}".`,
					)
				}
			}
			// Source must be untouched.
			const sourceAfter = indexWlansById(after.entries).get(sourceId)
			if (!sourceAfter || sourceAfter.rawXml !== source.rawXml) {
				throw new Error(
					`Source WLAN id "${sourceId}" changed during clone; expected it to remain identical.`,
				)
			}
		},
	})

	const created = indexWlansById(afterSnapshot.entries).get(createdId)
	if (!created) {
		throw new Error(
			`Cloned WLAN id "${createdId}" missing after successful safety check.`,
		)
	}

	return {
		sourceId,
		source,
		created,
		overridesApplied,
		safety,
		setconfXml,
	}
}

/**
 * Regression helper: simulate the Oct 12 overwrite-first bug shape and ensure
 * our safety diff detects duplicate ids + unexpected first-WLAN change.
 */
export function detectOverwriteFirstWlanBug(input: {
	before: Array<WlanSvcEntry>
	after: Array<WlanSvcEntry>
	intendedTargetId: string
}): WlanListDiff {
	return diffWlanLists({
		before: input.before,
		after: input.after,
		allowedChangedIds: new Set([input.intendedTargetId]),
		allowedAddedIds: new Set(),
	})
}
