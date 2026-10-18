import { expect, test } from 'vitest'
import {
	AccessNetworksUnleashedWlanSafetyError,
	cloneWlanById,
	detectOverwriteFirstWlanBug,
	updateWlanById,
} from './wlan-ops.ts'
import { extractWlansvcEntries, type WlanSvcEntry } from './wlan-xml.ts'
import { type AccessNetworksUnleashedClient } from './types.ts'

function wrapList(entries: Array<WlanSvcEntry>): string {
	return (
		'<ajax-response><response status="ok"><wlansvc-list>' +
		entries.map((entry) => entry.rawXml).join('') +
		'</wlansvc-list></response></ajax-response>'
	)
}

function initialEntries(): Array<WlanSvcEntry> {
	const xml = `
<ajax-response>
  <wlansvc-list>
    <wlansvc id='1' name='friendlyfamily' ssid='friendlyfamily' vlan-id='1' client-isolation='disabled' encryption='wpa2'>
      <wpa cipher='aes' passphrase='family-secret'/>
    </wlansvc>
    <wlansvc id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='10' client-isolation='enabled' is-guest='true' usage='guest' encryption='wpa2'>
      <wpa cipher='aes' passphrase='guest-secret'/>
      <guest-access portal='true'/>
    </wlansvc>
  </wlansvc-list>
</ajax-response>`
	return extractWlansvcEntries(xml)
}

function createFakeUnleashedClient(input?: {
	/**
	 * When true, a partial update of id 5 instead overwrites list position 0
	 * with the id=5 payload (the Oct 12 bug).
	 */
	overwriteFirstOnPartialUpdate?: boolean
	/**
	 * When true, a clone create also mutates id 1 unexpectedly.
	 */
	corruptSiblingOnClone?: boolean
}): {
	client: AccessNetworksUnleashedClient
	getEntries: () => Array<WlanSvcEntry>
	setconfBodies: Array<{ comp: string; xmlBody: string }>
} {
	let entries = initialEntries()
	const setconfBodies: Array<{ comp: string; xmlBody: string }> = []
	let nextCloneId = 20

	const client: AccessNetworksUnleashedClient = {
		async request(request) {
			if (request.action === 'getconf' && request.comp === 'wlansvc-list') {
				return {
					action: 'getconf',
					comp: 'wlansvc-list',
					updater: 'wlansvc-list.test',
					xml: wrapList(entries),
					parsed: null,
				}
			}
			if (request.action === 'setconf' && request.comp === 'wlansvc-list') {
				setconfBodies.push({
					comp: request.comp,
					xmlBody: request.xmlBody,
				})
				const body = request.xmlBody.trim()

				if (/DELETE\s*=\s*['"]true['"]/i.test(body)) {
					const idMatch = /\bid\s*=\s*['"]([^'"]+)['"]/i.exec(body)
					const id = idMatch?.[1]
					if (id) {
						// Delete only the first matching id (simulates cleaning
						// one duplicate occurrence at a time).
						const index = entries.findIndex((entry) => entry.id === id)
						if (index >= 0) {
							entries = [
								...entries.slice(0, index),
								...entries.slice(index + 1),
							]
						}
					}
					return {
						action: 'setconf',
						comp: 'wlansvc-list',
						updater: 'wlansvc-list.test',
						xml: '<ajax-response><ok/></ajax-response>',
						parsed: null,
					}
				}

				if (/IS_PARTIAL\s*=\s*['"]true['"]/i.test(body)) {
					const idMatch = /\bid\s*=\s*['"]([^'"]+)['"]/i.exec(body)
					const id = idMatch?.[1]
					if (!id) throw new Error('partial update missing id')
					const attrMatches = [
						...body.matchAll(/([\w-]+)\s*=\s*['"]([^'"]*)['"]/gi),
					]
					const patch: Record<string, string> = {}
					for (const match of attrMatches) {
						const name = match[1] ?? ''
						if (
							!name ||
							name === 'id' ||
							name.toUpperCase() === 'IS_PARTIAL' ||
							name.toUpperCase() === 'DELETE'
						) {
							continue
						}
						patch[name] = match[2] ?? ''
					}

					if (input?.overwriteFirstOnPartialUpdate) {
						// BUG SIMULATION: apply the patched object (keeping the
						// requested id) onto the first list slot.
						const source =
							entries.find((entry) => entry.id === id) ?? entries[0]
						if (!source) throw new Error('no source for bug simulation')
						let overwritten = source.rawXml.replace(
							/\sid\s*=\s*(['"])(.*?)\1/i,
							` id='${id}'`,
						)
						for (const [name, value] of Object.entries(patch)) {
							const pattern = new RegExp(
								`(\\s${name}\\s*=\\s*)(['"])(.*?)\\2`,
								'i',
							)
							if (pattern.test(overwritten)) {
								overwritten = overwritten.replace(pattern, `$1'${value}'`)
							} else {
								overwritten = overwritten.replace(
									/^<wlansvc/i,
									`<wlansvc ${name}='${value}'`,
								)
							}
						}
						// Force id on the first entry to the target id (duplicate).
						overwritten = overwritten.replace(
							/\sid\s*=\s*(['"])(.*?)\1/i,
							` id='${id}'`,
						)
						entries = [
							{
								...extractWlansvcEntries(overwritten)[0]!,
								id,
								rawXml: overwritten,
							},
							...entries.slice(1),
						]
					} else {
						entries = entries.map((entry) => {
							if (entry.id !== id) return entry
							let updated = entry.rawXml
							for (const [name, value] of Object.entries(patch)) {
								const pattern = new RegExp(
									`(\\s${name}\\s*=\\s*)(['"])(.*?)\\2`,
									'i',
								)
								if (pattern.test(updated)) {
									updated = updated.replace(pattern, `$1'${value}'`)
								} else {
									updated = updated.replace(
										/^<wlansvc/i,
										`<wlansvc ${name}='${value}'`,
									)
								}
							}
							return extractWlansvcEntries(updated)[0]!
						})
					}
					return {
						action: 'setconf',
						comp: 'wlansvc-list',
						updater: 'wlansvc-list.test',
						xml: '<ajax-response><ok/></ajax-response>',
						parsed: null,
					}
				}

				// Full-object restore or create (no IS_PARTIAL).
				const hasExplicitId = /\sid\s*=\s*['"]/i.test(body)
				const bodyWithId = hasExplicitId
					? body
					: body.replace(/^<wlansvc/i, `<wlansvc id='${String(nextCloneId++)}'`)
				const created = extractWlansvcEntries(bodyWithId)
				if (created.length === 0) {
					throw new Error(`fake client could not parse setconf body: ${body}`)
				}
				for (const entry of created) {
					const existingIndex = entries.findIndex((row) => row.id === entry.id)
					if (existingIndex >= 0) {
						entries = [
							...entries.slice(0, existingIndex),
							entry,
							...entries.slice(existingIndex + 1),
						]
					} else {
						entries = [...entries, entry]
						if (input?.corruptSiblingOnClone && entries[0]) {
							// Unexpected sibling mutation during clone.
							const sibling = entries[0]
							const corrupted = sibling.rawXml.replace(
								/vlan-id='1'/,
								"vlan-id='999'",
							)
							entries = [
								extractWlansvcEntries(corrupted)[0]!,
								...entries.slice(1),
							]
						}
					}
				}
				return {
					action: 'setconf',
					comp: 'wlansvc-list',
					updater: 'wlansvc-list.test',
					xml: '<ajax-response><ok/></ajax-response>',
					parsed: null,
				}
			}
			throw new Error(
				`unexpected fake request ${request.action} ${request.comp}`,
			)
		},
	}

	return {
		client,
		getEntries: () => entries,
		setconfBodies,
	}
}

test('updateWlanById sends partial id-targeted setconf and leaves siblings untouched', async () => {
	const fake = createFakeUnleashedClient()
	const result = await updateWlanById({
		client: fake.client,
		id: '5',
		attributes: { 'vlan-id': '20' },
	})
	expect(result.setconfXml).toBe(
		"<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>",
	)
	expect(result.after.attributes['vlan-id']).toBe('20')
	expect(result.safety.rolledBack).toBe(false)
	const family = fake.getEntries().find((entry) => entry.id === '1')
	expect(family?.attributes['vlan-id']).toBe('1')
	expect(family?.name).toBe('friendlyfamily')
})

test('regression: overwrite-first bug is detected and rolled back', async () => {
	const fake = createFakeUnleashedClient({
		overwriteFirstOnPartialUpdate: true,
	})
	let thrown: unknown
	try {
		await updateWlanById({
			client: fake.client,
			id: '5',
			attributes: { 'vlan-id': '20' },
		})
	} catch (error) {
		thrown = error
	}
	expect(thrown).toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)
	const safetyError = thrown as AccessNetworksUnleashedWlanSafetyError
	expect(safetyError.safety.rolledBack).toBe(true)
	expect(safetyError.message).toMatch(/roll(?:ed)? back/i)
	expect(
		safetyError.safety.diff.duplicateIds.length +
			safetyError.safety.diff.missingIds.length,
	).toBeGreaterThan(0)

	// After rollback, original ids/names must be restored.
	const restored = fake.getEntries()
	expect(restored.map((entry) => entry.id).sort()).toEqual(['1', '5'])
	expect(restored.find((entry) => entry.id === '1')?.name).toBe(
		'friendlyfamily',
	)
	expect(
		restored.find((entry) => entry.id === '5')?.attributes['vlan-id'],
	).toBe('10')
})

test('cloneWlanById copies guest portal, isolation, and vlan; applies overrides', async () => {
	const fake = createFakeUnleashedClient()
	const result = await cloneWlanById({
		client: fake.client,
		sourceId: '5',
		overrides: {
			name: 'guest24',
			ssid: 'guest24',
			radioBand: '2.4ghz',
		},
	})
	expect(result.created.id).not.toBe('5')
	expect(result.created.name).toBe('guest24')
	expect(result.created.attributes['vlan-id']).toBe('10')
	expect(result.created.attributes['client-isolation']).toBe('enabled')
	expect(result.created.rawXml).toContain("<guest-access portal='true'/>")
	expect(result.created.attributes['radio']).toBe('2.4G')
	expect(result.safety.rolledBack).toBe(false)
	expect(result.setconfXml).not.toMatch(/\sid\s*=/)
	expect(fake.getEntries().find((entry) => entry.id === '5')?.rawXml).toBe(
		result.source.rawXml,
	)
})

test('cloneWlanById rolls back when another WLAN changes', async () => {
	const fake = createFakeUnleashedClient({ corruptSiblingOnClone: true })
	await expect(
		cloneWlanById({
			client: fake.client,
			sourceId: '5',
			overrides: { name: 'guest-copy', ssid: 'guest-copy' },
		}),
	).rejects.toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)

	const restored = fake.getEntries()
	expect(restored.map((entry) => entry.id).sort()).toEqual(['1', '5'])
	expect(
		restored.find((entry) => entry.id === '1')?.attributes['vlan-id'],
	).toBe('1')
})

test('duplicate-id detection fails the safety diff even when intended id changed', () => {
	const before = initialEntries()
	const after = [
		{
			...before[0]!,
			id: '5',
			rawXml: before[0]!.rawXml.replace(/\sid\s*=\s*(['"])1\1/, " id='5'"),
		},
		before[1]!,
	]
	const diff = detectOverwriteFirstWlanBug({
		before,
		after,
		intendedTargetId: '5',
	})
	expect(diff.ok).toBe(false)
	expect(diff.duplicateIds).toContain('5')
})
