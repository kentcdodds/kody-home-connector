import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { type AccessNetworksUnleashedClient } from './types.ts'
import {
	AccessNetworksUnleashedWlanSafetyError,
	AccessNetworksUnleashedWlanWriteRefusedError,
	assertTargetedWlanWrite,
	checkWlanWriteReadiness,
	cloneWlanById,
	deleteWlanById,
	getWlanById,
	mergeWlanOntoTemplate,
	parseGuestserviceList,
	readWlanList,
	resolveWlanAttributeOverrides,
	updateWlanById,
} from './wlan-ops.ts'
import {
	getAttributeValue,
	parseWlansvcList,
	removeRootAttributes,
	setOrAddAttribute,
} from './wlan-xml.ts'

/**
 * Fake Unleashed controller built from the REDACTED real wlansvc-list
 * captured during the Oct 17 2026 incident (fixtures/). Behaviour mirrors
 * what the real controller did / what the vendor docs describe:
 *
 * - getconf DECRYPT_X="false": wpa has no passphrase / x-passphrase and an
 *   empty sae-passphrase (observed); DECRYPT_X="true": plaintext passphrase
 *   plus x- twin (aioruckus).
 * - setconf with ONE <wlansvc>: replaces the FIRST list entry with the payload
 *   verbatim, whatever its id (observed Oct 12 with id=5, Oct 17 with no id).
 * - addobj: appends with a controller-assigned id, echoes the object.
 * - updobj: targets the id (IS_PARTIAL merges root attributes).
 * - delobj: deletes by id.
 */
const TEST_SECRETS: Record<string, { psk: string; guestPass?: string }> = {
	'1': { psk: 'TEST-ONLY-family-psk' },
	'2': { psk: 'TEST-ONLY-g-psk' },
	'3': { psk: 'TEST-ONLY-family24-psk' },
	'5': { psk: 'TEST-ONLY-guest-psk', guestPass: 'TEST-ONLY-guest-pass' },
}

function fixture(name: string) {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** Turn a redacted fixture element into the DECRYPT_X="true" stored form. */
function withTestSecrets(rawXml: string, id: string | null): string {
	const secrets = id ? TEST_SECRETS[id] : undefined
	if (!secrets) return rawXml
	let xml = rawXml
	if (secrets.guestPass) {
		xml = xml.replace(/guest-pass="[^"]*"/, `guest-pass="${secrets.guestPass}"`)
	}
	return xml.replace(
		/<wpa cipher="aes"/,
		`<wpa cipher="aes" x-passphrase="${secrets.psk}" passphrase="${secrets.psk}"`,
	)
}

function stripForNoDecrypt(rawXml: string): string {
	return rawXml
		.replace(
			/\s(?:x-passphrase|passphrase|x-sae-passphrase)=(["'])[^"']*\1/g,
			'',
		)
		.replace(/(\ssae-passphrase=)(["'])[^"']*\2/g, '$1$2$2')
		.replace(/(\sguest-pass=)(["'])[^"']*\2/g, '$1$2$2')
}

type FakeOptions = {
	initialXml?: string
	/**
	 * addobj behaves like the positional setconf (simulates a firmware
	 * surprise): only the first addobj, or every addobj.
	 */
	addobjOverwritesFirst?: 'once' | 'always'
	/** updobj applies to the first entry, keeping the payload id (Oct 12 shape). */
	updobjOverwritesFirst?: boolean
	/** addobj also changes a sibling's vlan. */
	addobjCorruptsSibling?: boolean
	/** DECRYPT_X="true" still omits passphrases (firmware not cooperating). */
	decryptOmitsSecrets?: boolean
	/** Apply the write, then throw as if the HTTP response was lost. */
	writeThrowsAfterApplying?: boolean
}

function createFakeController(options: FakeOptions = {}) {
	const initial = parseWlansvcList(
		options.initialXml ?? fixture('wlansvc-list-before-clone-incident.xml'),
	)
	// Keep list order including id-less anomalies.
	type Slot = { rawXml: string }
	const combined: Array<{ index: number; rawXml: string; id: string | null }> =
		initial.entries.map((entry, i) => ({
			index: i,
			rawXml: entry.rawXml,
			id: entry.id,
		}))
	for (const anomaly of initial.anomalies) {
		combined.splice(anomaly.index, 0, {
			index: anomaly.index,
			rawXml: anomaly.rawXml,
			id: null,
		})
	}
	let slots: Array<Slot> = combined.map((row) => ({
		rawXml: withTestSecrets(row.rawXml, row.id),
	}))
	let nextId = 6
	let nextGuestserviceId = 10
	let addobjSurpriseUsed = false
	const writes: Array<{ action: string; xmlBody: string; comp: string }> = []
	const templateReads: Array<boolean> = []
	const guestserviceSlots: Array<Slot> = parseGuestserviceList(
		fixture('guestservice-list.xml'),
	).entries.map((entry) => ({ rawXml: entry.rawXml }))

	const idOf = (rawXml: string, tag = 'wlansvc') => {
		const open = new RegExp(`^<${tag}[^>]*>`, 'i').exec(rawXml)?.[0] ?? ''
		return getAttributeValue(open, 'id')
	}
	const listXml = (decrypt: boolean) =>
		'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE ajax-response><ajax-response><response type="object" id="wlansvc-list.test"><wlansvc-list>' +
		slots
			.map((slot) =>
				decrypt && !options.decryptOmitsSecrets
					? slot.rawXml
					: stripForNoDecrypt(slot.rawXml),
			)
			.join('') +
		'</wlansvc-list></response></ajax-response>'
	const ok = (action: string, inner = '') => ({
		action: action as 'getconf',
		comp: 'wlansvc-list',
		updater: 'wlansvc-list.test',
		xml: `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE ajax-response><ajax-response><response type="object" id="wlansvc-list.test">${inner}</response></ajax-response>`,
		parsed: null,
	})
	const normalizeBody = (body: string) => body.trim()
	const overwriteFirst = (body: string) => {
		slots = [{ rawXml: body }, ...slots.slice(1)]
	}
	const patchRoot = (rawXml: string, attrs: Record<string, string>) => {
		let updated = rawXml
		for (const [name, value] of Object.entries(attrs)) {
			updated = setOrAddAttribute(updated, name, value)
		}
		return updated
	}

	const guestListXml = () =>
		'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE ajax-response><ajax-response><response type="object" id="guestservice-list.test"><guestservice-list>' +
		guestserviceSlots.map((slot) => slot.rawXml).join('') +
		'</guestservice-list></response></ajax-response>'

	const apply = (action: string, body: string, comp: string) => {
		if (comp === 'guestservice-list') {
			const id = idOf(body, 'guestservice')
			if (action === 'addobj') {
				const newId = String(nextGuestserviceId++)
				const created = body.replace(
					/^<guestservice/i,
					`<guestservice id="${newId}"`,
				)
				guestserviceSlots.push({ rawXml: created })
				return {
					...ok(action),
					comp: 'guestservice-list',
					xml: `<?xml version="1.0"?><ajax-response><response type="object">${created}</response></ajax-response>`,
				}
			}
			if (action === 'delobj') {
				if (!id) throw new Error('fake: guestservice delobj needs id')
				const index = guestserviceSlots.findIndex(
					(slot) => idOf(slot.rawXml, 'guestservice') === id,
				)
				if (index >= 0) guestserviceSlots.splice(index, 1)
				return { ...ok(action), comp: 'guestservice-list' }
			}
			throw new Error(`fake: unsupported guestservice action ${action}`)
		}
		const id = idOf(body)
		switch (action) {
			case 'setconf': {
				overwriteFirst(body)
				return ok(action)
			}
			case 'addobj': {
				if (
					options.addobjOverwritesFirst === 'always' ||
					(options.addobjOverwritesFirst === 'once' && !addobjSurpriseUsed)
				) {
					addobjSurpriseUsed = true
					overwriteFirst(body)
					return ok(action)
				}
				const newId = String(nextId++)
				const created = body.replace(
					/^<wlansvc/i,
					`<wlansvc id="${newId}" create-time="1792290000"`,
				)
				slots = [...slots, { rawXml: created }]
				if (options.addobjCorruptsSibling) {
					slots = slots.map((slot) =>
						idOf(slot.rawXml) === '2'
							? { rawXml: slot.rawXml.replace('vlan-id="1"', 'vlan-id="999"') }
							: slot,
					)
				}
				return ok(action, stripForNoDecrypt(created))
			}
			case 'updobj': {
				if (!id) throw new Error('fake: updobj needs id')
				const partial = /IS_PARTIAL\s*=\s*['"]true['"]/i.test(body)
				const attrs: Record<string, string> = {}
				if (partial) {
					for (const match of body.matchAll(
						/([\w-]+)\s*=\s*['"]([^'"]*)['"]/g,
					)) {
						const name = match[1] ?? ''
						if (name === 'id' || name === 'IS_PARTIAL') continue
						attrs[name] = match[2] ?? ''
					}
				}
				if (options.updobjOverwritesFirst) {
					const source = slots.find((slot) => idOf(slot.rawXml) === id)
					if (!source) throw new Error('fake: no source')
					overwriteFirst(partial ? patchRoot(source.rawXml, attrs) : body)
					return ok(action)
				}
				const index = slots.findIndex((slot) => idOf(slot.rawXml) === id)
				if (index < 0) throw new Error(`fake: updobj id ${id} not found`)
				slots[index] = {
					rawXml: partial ? patchRoot(slots[index]!.rawXml, attrs) : body,
				}
				return ok(action)
			}
			case 'delobj': {
				if (!id) throw new Error('fake: delobj needs id')
				const index = slots.findIndex((slot) => idOf(slot.rawXml) === id)
				if (index >= 0)
					slots = [...slots.slice(0, index), ...slots.slice(index + 1)]
				return ok(action)
			}
			default:
				throw new Error(`fake: unsupported action ${action}`)
		}
	}

	let throwOnce = options.writeThrowsAfterApplying ?? false
	const client: AccessNetworksUnleashedClient = {
		async request(request) {
			if (
				request.action === 'getconf' &&
				request.comp === 'wlansvc-standard-template'
			) {
				templateReads.push(request.decryptSecrets === true)
				return {
					...ok('getconf'),
					xml: fixture('wlansvc-standard-template.xml'),
				}
			}
			if (
				request.action === 'getconf' &&
				request.comp === 'guestservice-list'
			) {
				return {
					...ok('getconf'),
					comp: 'guestservice-list',
					xml: guestListXml(),
				}
			}
			if (
				request.comp !== 'wlansvc-list' &&
				request.comp !== 'guestservice-list'
			) {
				throw new Error(`fake: unexpected comp ${request.comp}`)
			}
			if (request.action === 'getconf' && request.comp === 'wlansvc-list') {
				return {
					...ok('getconf'),
					xml: listXml(request.decryptSecrets === true),
				}
			}
			const body = normalizeBody(request.xmlBody)
			writes.push({ action: request.action, xmlBody: body, comp: request.comp })
			const result = apply(request.action, body, request.comp)
			// Only the WLAN write throws after apply; guestservice setup must
			// complete so the regression covers the wlansvc path.
			if (throwOnce && request.comp === 'wlansvc-list') {
				throwOnce = false
				throw new Error(
					`Access Networks Unleashed rejected the command: <xmsg error="1"/> echo ${body}`,
				)
			}
			return result
		},
	}
	return {
		client,
		writes,
		templateReads,
		list: () => parseWlansvcList(listXml(true)),
		guestservices: () => parseGuestserviceList(guestListXml()),
		rawStoredXml: () => listXml(true),
	}
}

function namesById(fake: ReturnType<typeof createFakeController>) {
	return fake.list().entries.map((entry) => [entry.id, entry.name])
}

const ALL_TEST_SECRETS = /TEST-ONLY-[\w-]+/

test('fake controller reproduces the Oct 17 incident from the real request shape', async () => {
	const fake = createFakeController()
	const before = parseWlansvcList(
		fixture('wlansvc-list-before-clone-incident.xml'),
	)
	const guest = before.entries.find((entry) => entry.id === '5')!
	// What PR #75 sent: the source minus id, overrides applied, as setconf.
	let body = removeRootAttributes(guest.rawXml, ['id'])
	for (const [name, value] of Object.entries({
		name: 'friendlyguest-2.4',
		ssid: 'friendlyguest-2.4',
		description: 'friendlyguest-2.4',
		'wlan-bind-24g': 'true',
		'wlan-bind-5g': 'false',
		'wlan-bind-6g': 'false',
	})) {
		body = setOrAddAttribute(body, name, value)
	}
	await fake.client.request({
		action: 'setconf',
		comp: 'wlansvc-list',
		xmlBody: body,
	})

	const actual = fake.list()
	const observed = parseWlansvcList(
		fixture('wlansvc-list-after-clone-incident.xml'),
	)
	expect(actual.entries.map((entry) => entry.id)).toEqual(
		observed.entries.map((entry) => entry.id),
	)
	expect(
		actual.anomalies.map((anomaly) => [anomaly.index, anomaly.name]),
	).toEqual(observed.anomalies.map((anomaly) => [anomaly.index, anomaly.name]))
})

test('assertTargetedWlanWrite refuses any write without an explicit target id or add action', () => {
	expect(() =>
		assertTargetedWlanWrite(
			'setconf',
			"<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>",
		),
	).toThrow(/setconf/)
	expect(() =>
		assertTargetedWlanWrite(
			'updobj',
			"<wlansvc IS_PARTIAL='true' vlan-id='20'/>",
		),
	).toThrow(/explicit wlansvc id/)
	expect(() => assertTargetedWlanWrite('delobj', "<wlansvc id=''/>")).toThrow(
		/explicit wlansvc id/,
	)
	expect(() =>
		assertTargetedWlanWrite('addobj', "<wlansvc id='9' name='x'/>"),
	).toThrow(/assigns ids/)
	expect(() =>
		assertTargetedWlanWrite('updobj', "<wlansvc id='1'/><wlansvc id='2'/>"),
	).toThrow(/exactly one/)
	expect(() =>
		assertTargetedWlanWrite(
			'updobj',
			"<wlansvc-list><wlansvc id='1'/></wlansvc-list>",
		),
	).toThrow(/wlansvc-list/)
	expect(() => assertTargetedWlanWrite('docmd', "<wlansvc id='1'/>")).toThrow(
		/Only addobj/,
	)
	// guestservice-id is not the id.
	expect(() =>
		assertTargetedWlanWrite(
			'updobj',
			"<wlansvc guestservice-id='5' IS_PARTIAL='true'/>",
		),
	).toThrow(/explicit wlansvc id/)
	expect(() =>
		assertTargetedWlanWrite(
			'addobj',
			"<wlansvc name='x' guestservice-id='5'/>",
		),
	).not.toThrow()
	expect(() =>
		assertTargetedWlanWrite('updobj', "<wlansvc id='5' IS_PARTIAL='true'/>"),
	).not.toThrow()
})

test('radioBand maps onto the real wlan-bind-* flags, never the bogus radio attribute', () => {
	expect(resolveWlanAttributeOverrides({ radioBand: '2.4ghz' })).toEqual({
		'wlan-bind-24g': 'true',
		'wlan-bind-5g': 'false',
		'wlan-bind-6g': 'false',
	})
	expect(resolveWlanAttributeOverrides({ radioBand: 'all' })).toEqual({
		'wlan-bind-24g': 'true',
		'wlan-bind-5g': 'true',
		'wlan-bind-6g': 'true',
	})
	expect(
		resolveWlanAttributeOverrides({ radioBand: '5ghz' })['wlan-bind-5g'],
	).toBe('true')
	expect(() =>
		resolveWlanAttributeOverrides({
			radioBand: '2.4ghz',
			attributes: { 'wlan-bind-5g': 'true' },
		}),
	).toThrow(/one or the other/)
})

test('clone uses addobj with no id, correct radio flags, and leaves siblings untouched', async () => {
	const fake = createFakeController()
	const result = await cloneWlanById({
		client: fake.client,
		sourceId: '5',
		overrides: {
			name: 'friendlyguest-2.4',
			ssid: 'friendlyguest-2.4',
			description: 'friendlyguest-2.4',
			radioBand: '2.4ghz',
		},
	})
	expect(fake.writes.map((write) => [write.comp, write.action])).toEqual([
		['guestservice-list', 'addobj'],
		['wlansvc-list', 'addobj'],
	])
	// Started from wlansvc-standard-template (aioruckus do_clone_wlan).
	expect(fake.templateReads).toEqual([true])
	const wlanWrite = fake.writes.find((write) => write.comp === 'wlansvc-list')!
	expect(wlanWrite.xmlBody).not.toContain('Ruckus-Wireless 1')
	// Source values win over template defaults (template is wpa23-mixed).
	expect(getAttributeValue(wlanWrite.xmlBody, 'encryption')).toBe('wpa2')
	expect(wlanWrite.xmlBody).not.toMatch(/\sid\s*=/)
	expect(wlanWrite.xmlBody).not.toMatch(/create-time/)
	expect(wlanWrite.xmlBody).not.toMatch(/\sradio\s*=/)
	expect(result.created).not.toBeNull()
	expect(result.safety).not.toBeNull()
	expect(result.created!.id).toBe('6')
	expect(result.created!.attributes['wlan-bind-24g']).toBe('true')
	expect(result.created!.attributes['wlan-bind-5g']).toBe('false')
	expect(result.created!.attributes['wlan-bind-6g']).toBe('false')
	expect(result.created!.attributes['vlan-id']).toBe('20')
	expect(result.created!.attributes['client-isolation']).toBe('enabled')
	expect(result.created!.attributes['web-auth']).toBe('enabled')
	// Dedicated guestservice — never shares friendlyguest's id 5.
	expect(result.created!.attributes['guestservice-id']).toBe('10')
	expect(result.created!.attributes['guestservice-id']).not.toBe('5')
	// Passphrase carried into the clone so it is a working copy.
	expect(result.created!.rawXml).toContain('passphrase="TEST-ONLY-guest-psk"')
	expect(result.safety!.rolledBack).toBe(false)
	// Secrets never appear in what the tool returns as the request.
	expect(result.requestXml).not.toMatch(ALL_TEST_SECRETS)
	expect(result.warnings.join(' ')).toMatch(/dedicated guestservice/)
	expect(namesById(fake)).toEqual([
		['1', 'friendlyfamily'],
		['2', 'g'],
		['3', 'friendlyfamily-2.4'],
		['5', 'friendlyguest'],
		['6', 'friendlyguest-2.4'],
	])
})

test('regression (Oct 17): positional overwrite with an id-less entry rolls back BEFORE erroring and restores the passphrase', async () => {
	const fake = createFakeController({ addobjOverwritesFirst: 'once' })
	let thrown: unknown
	try {
		await cloneWlanById({
			client: fake.client,
			sourceId: '5',
			overrides: {
				name: 'friendlyguest-2.4',
				ssid: 'friendlyguest-2.4',
				radioBand: '2.4ghz',
			},
		})
	} catch (error) {
		thrown = error
	}
	// Not the old "wlansvc without an id ... Refusing" abort.
	expect(thrown).toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)
	const safety = (thrown as AccessNetworksUnleashedWlanSafetyError).safety
	expect(safety.problems.join(' ')).toMatch(/has no id/)
	expect(safety.restore).not.toBeNull()
	// Rollback ran: friendlyfamily was re-created with its passphrase.
	const recreate = safety.restore!.actions.find(
		(action) => action.op === 'addobj',
	)
	expect(recreate).toMatchObject({ id: '1', name: 'friendlyfamily', ok: true })
	const family = fake
		.list()
		.entries.find((entry) => entry.name === 'friendlyfamily')
	expect(family).toBeDefined()
	expect(family!.rawXml).toContain('passphrase="TEST-ONLY-family-psk"')
	expect(safety.restore!.reassignedIds['1']).toBe(family!.id)
	// The id-less slot cannot be targeted by any action: reported, not guessed.
	expect(safety.restore!.status).toBe('partial')
	expect(safety.restore!.unresolved.join(' ')).toMatch(/no id/)
	// partial restore still counts as rolledBack (content restored; old ids may
	// have been reassigned and need manual follow-up).
	expect(safety.rolledBack).toBe(true)
	// Writes sent: guestservice+wlan addobj, then only id-targeted restore.
	for (const write of fake.writes.slice(2)) {
		expect(['updobj', 'addobj', 'delobj']).toContain(write.action)
	}
	expect(fake.writes.some((write) => write.action === 'setconf')).toBe(false)
	// No secret ever leaks into the error.
	expect((thrown as Error).message).not.toMatch(ALL_TEST_SECRETS)
	expect(JSON.stringify(safety)).not.toMatch(ALL_TEST_SECRETS)
})

test('if every addobj were positional, rollback reports failure for manual repair instead of looping', async () => {
	const fake = createFakeController({ addobjOverwritesFirst: 'always' })
	const error = await cloneWlanById({
		client: fake.client,
		sourceId: '5',
		overrides: { name: 'x-copy', ssid: 'x-copy' },
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)
	const safety = (error as AccessNetworksUnleashedWlanSafetyError).safety
	expect(safety.rolledBack).toBe(true)
	expect(['partial', 'failed']).toContain(safety.restore?.status)
	expect((error as Error).message).toMatch(/manual repair needed/)
	// guestservice addobj + one wlansvc addobj create + one restore addobj;
	// no retry loop on the restore.
	expect(
		fake.writes.filter(
			(write) => write.comp === 'wlansvc-list' && write.action === 'addobj',
		),
	).toHaveLength(2)
})

test('clone that disturbs a sibling is fully rolled back with updobj + delobj', async () => {
	const fake = createFakeController({ addobjCorruptsSibling: true })
	await expect(
		cloneWlanById({
			client: fake.client,
			sourceId: '2',
			overrides: {
				name: 'g-copy',
				ssid: 'g-copy',
				attributes: { 'enable-type': '1' },
			},
		}),
	).rejects.toSatisfy((error: unknown) => {
		const safety = (error as AccessNetworksUnleashedWlanSafetyError).safety
		return (
			error instanceof AccessNetworksUnleashedWlanSafetyError &&
			safety.rolledBack &&
			safety.restore?.status === 'restored'
		)
	})
	const after = fake.list()
	expect(after.entries.map((entry) => entry.id)).toEqual(['1', '2', '3', '5'])
	expect(
		after.entries.find((entry) => entry.id === '2')!.attributes['vlan-id'],
	).toBe('1')
	expect(fake.writes.map((write) => [write.comp, write.action])).toEqual([
		['guestservice-list', 'addobj'],
		['wlansvc-list', 'addobj'],
		['wlansvc-list', 'delobj'],
		['wlansvc-list', 'updobj'],
		['guestservice-list', 'delobj'],
	])
})

test('write request that errors after applying still verifies and rolls back', async () => {
	const fake = createFakeController({
		addobjOverwritesFirst: 'once',
		writeThrowsAfterApplying: true,
	})
	const error = await cloneWlanById({
		client: fake.client,
		sourceId: '5',
		overrides: { name: 'x-copy', ssid: 'x-copy' },
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)
	const safety = (error as AccessNetworksUnleashedWlanSafetyError).safety
	expect(safety.problems[0]).toMatch(/write request failed/)
	expect(safety.problems[0]).not.toMatch(ALL_TEST_SECRETS)
	expect(
		safety.restore?.actions.some(
			(action) => action.op === 'addobj' && action.ok,
		),
	).toBe(true)
})

test('update uses updobj IS_PARTIAL by id and verifies only the target changed', async () => {
	const fake = createFakeController()
	const result = await updateWlanById({
		client: fake.client,
		id: '5',
		attributes: { 'max-clients-per-radio': '50' },
	})
	expect(result.requestAction).toBe('updobj')
	expect(result.requestXml).toBe(
		"<wlansvc id='5' IS_PARTIAL='true' max-clients-per-radio='50'/>",
	)
	expect(fake.writes).toEqual([
		{ action: 'updobj', comp: 'wlansvc-list', xmlBody: result.requestXml },
	])
	expect(result.after).not.toBeNull()
	expect(result.safety).not.toBeNull()
	expect(result.after!.attributes['max-clients-per-radio']).toBe('50')
	expect(result.safety!.rolledBack).toBe(false)
})

test('regression (Oct 12): updobj applied to the first slot is detected and rolled back', async () => {
	const fake = createFakeController({ updobjOverwritesFirst: true })
	const error = await updateWlanById({
		client: fake.client,
		id: '5',
		attributes: { 'vlan-id': '30' },
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)
	const safety = (error as AccessNetworksUnleashedWlanSafetyError).safety
	expect(safety.problems.join(' ')).toMatch(/duplicate wlansvc id\(s\): 5/)
	expect(safety.restore).not.toBeNull()
	// Duplicate ids cannot be targeted safely; reported for manual repair.
	expect(safety.restore!.unresolved.join(' ')).toMatch(/appears more than once/)
	// friendlyfamily was re-created with its secret.
	const family = fake
		.list()
		.entries.find((entry) => entry.name === 'friendlyfamily')
	expect(family?.rawXml).toContain('passphrase="TEST-ONLY-family-psk"')
})

test('update refuses unknown, controller-owned, secret, and bogus radio attributes without writing', async () => {
	const fake = createFakeController()
	const refused: Array<Record<string, string>> = [
		{ radio: '2.4G' },
		{ id: '9' },
		{ 'guest-pass': 'x' },
		{ 'not-a-real-attr': '1' },
	]
	for (const attributes of refused) {
		await expect(
			updateWlanById({ client: fake.client, id: '5', attributes }),
		).rejects.toBeInstanceOf(AccessNetworksUnleashedWlanWriteRefusedError)
	}
	expect(fake.writes).toEqual([])
})

test('writes refuse (nothing sent) when the snapshot cannot capture passphrases', async () => {
	const fake = createFakeController({ decryptOmitsSecrets: true })
	await expect(
		cloneWlanById({
			client: fake.client,
			sourceId: '2',
			overrides: { name: 'g-copy', ssid: 'g-copy' },
		}),
	).rejects.toThrow(/fully restorable snapshot is not possible/)
	expect(fake.writes).toEqual([])
	const readiness = await checkWlanWriteReadiness(fake.client)
	expect(readiness.ready).toBe(false)
	expect(readiness.wlans.find((wlan) => wlan.id === '1')?.restorable).toBe(
		false,
	)
	expect(JSON.stringify(readiness)).not.toMatch(ALL_TEST_SECRETS)
})

test('recovery: on the damaged Oct 17 list reads work and writes refuse without sending', async () => {
	const fake = createFakeController({
		initialXml: fixture('wlansvc-list-after-clone-incident.xml'),
	})
	const list = await readWlanList(fake.client)
	expect(list.entries.map((entry) => entry.id)).toEqual(['2', '3', '5'])
	expect(list.anomalies[0]?.name).toBe('friendlyguest-2.4')
	const { wlan } = await getWlanById(fake.client, '5')
	expect(wlan.name).toBe('friendlyguest')

	await expect(
		updateWlanById({
			client: fake.client,
			id: '5',
			attributes: { 'vlan-id': '20' },
		}),
	).rejects.toThrow(/damaged.*has no id.*Nothing was sent/)
	await expect(
		deleteWlanById({ client: fake.client, id: '2', expectedName: 'g' }),
	).rejects.toBeInstanceOf(AccessNetworksUnleashedWlanWriteRefusedError)
	expect(fake.writes).toEqual([])

	const readiness = await checkWlanWriteReadiness(fake.client)
	expect(readiness.ready).toBe(false)
	expect(readiness.problems.join(' ')).toMatch(/friendlyguest-2\.4.*has no id/)
})

test('clone refuses duplicate names/SSIDs and the legacy radio attribute', async () => {
	const fake = createFakeController()
	await expect(
		cloneWlanById({
			client: fake.client,
			sourceId: '5',
			overrides: { ssid: 'x-new' },
		}),
	).rejects.toThrow(/named "friendlyguest" already exists/)
	await expect(
		cloneWlanById({
			client: fake.client,
			sourceId: '5',
			overrides: { name: 'n', ssid: 'n', attributes: { radio: '2.4G' } },
		}),
	).rejects.toThrow(/"radio" is not an Unleashed wlansvc attribute/)
	expect(fake.writes).toEqual([])
})

test('delete uses delobj by id after an expectedName check', async () => {
	const fake = createFakeController()
	const created = await cloneWlanById({
		client: fake.client,
		sourceId: '2',
		overrides: {
			name: 'kody-test',
			ssid: 'kody-test',
			attributes: { 'enable-type': '1' },
		},
	})
	expect(created.created).not.toBeNull()
	expect(created.created!.attributes['enable-type']).toBe('1')
	await expect(
		deleteWlanById({
			client: fake.client,
			id: created.created!.id,
			expectedName: 'g',
		}),
	).rejects.toThrow(/is named "kody-test"/)
	const deleted = await deleteWlanById({
		client: fake.client,
		id: created.created!.id,
		expectedName: 'kody-test',
	})
	expect(deleted.requestXml).toBe(`<wlansvc id='${created.created!.id}'/>`)
	expect(fake.writes.map((write) => [write.comp, write.action])).toEqual([
		['guestservice-list', 'addobj'],
		['wlansvc-list', 'addobj'],
		['wlansvc-list', 'delobj'],
		['guestservice-list', 'delobj'],
	])
	expect(namesById(fake)).toEqual([
		['1', 'friendlyfamily'],
		['2', 'g'],
		['3', 'friendlyfamily-2.4'],
		['5', 'friendlyguest'],
	])
})

test('stored fake list still holds secrets (sanity) while read tools never see them', async () => {
	const fake = createFakeController()
	expect(fake.rawStoredXml()).toMatch(ALL_TEST_SECRETS)
	const list = await readWlanList(fake.client)
	expect(list.xml).not.toMatch(ALL_TEST_SECRETS)
})

test('mergeWlanOntoTemplate keeps template-only defaults and lets the source win', () => {
	const merged = mergeWlanOntoTemplate({
		templateXml:
			'<wlansvc name="Ruckus-Wireless 1" encryption="wpa23-mixed" transient-client-mgnt="0"><wpa cipher="aes" x-passphrase="" passphrase=""/><rrm neighbor-report="enabled"/></wlansvc>',
		sourceXml:
			"<wlansvc name='src &amp; co' encryption='wpa2' vlan-id='20'><wpa cipher='aes' passphrase='TEST-ONLY-p'/><qos uplink-preset='DISABLE'/></wlansvc>",
	})
	const parsed = parseWlansvcList(
		merged.replace('<wlansvc ', '<wlansvc id="x" '),
	).entries[0]!
	expect(parsed.attributes).toMatchObject({
		name: 'src & co',
		encryption: 'wpa2',
		'vlan-id': '20',
		'transient-client-mgnt': '0',
	})
	expect(merged).toContain('passphrase="TEST-ONLY-p"')
	expect(merged).toContain('<rrm neighbor-report="enabled"/>')
	expect(merged).toContain('<qos uplink-preset="DISABLE"/>')
	expect(merged).toContain('name="src &amp; co"')
})

test('acceptUnrestorablePassphrases lets a write proceed but rollback never rewrites or re-creates those WLANs', async () => {
	const fake = createFakeController({
		decryptOmitsSecrets: true,
		updobjOverwritesFirst: true,
	})
	const error = await updateWlanById({
		client: fake.client,
		id: '3',
		attributes: { 'max-clients-per-radio': '50' },
		acceptUnrestorablePassphrases: true,
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AccessNetworksUnleashedWlanSafetyError)
	const restore = (error as AccessNetworksUnleashedWlanSafetyError).safety
		.restore!
	expect(restore.actions.some((action) => action.op === 'addobj')).toBe(false)
	expect(restore.unresolved.join(' ')).toMatch(
		/id "1" \(friendlyfamily\) is missing and its passphrase was not captured/,
	)
	// Root-attribute-only restores (no <wpa> rewrite) for unrestorable WLANs.
	for (const write of fake.writes.slice(1)) {
		if (write.action === 'updobj')
			expect(write.xmlBody).toMatch(/IS_PARTIAL='true'/)
	}
})

test('clone refuses even with acceptUnrestorablePassphrases when the source PSK was not captured', async () => {
	const fake = createFakeController({ decryptOmitsSecrets: true })
	await expect(
		cloneWlanById({
			client: fake.client,
			sourceId: '2',
			overrides: { name: 'g-copy', ssid: 'g-copy' },
			acceptUnrestorablePassphrases: true,
		}),
	).rejects.toThrow(/copy would have no PSK/)
	expect(fake.writes).toEqual([])
})

test('dryRun clone of id 5 as friendlyguest-2.4 2.4GHz-only returns guestservice+wlan addobj and sends nothing', async () => {
	const fake = createFakeController()
	const before = namesById(fake)
	const result = await cloneWlanById({
		client: fake.client,
		sourceId: '5',
		overrides: {
			name: 'friendlyguest-2.4',
			ssid: 'friendlyguest-2.4',
			description: 'friendlyguest-2.4',
			radioBand: '2.4ghz',
		},
		dryRun: true,
	})
	expect(result.dryRun).toBe(true)
	expect(result.created).toBeNull()
	expect(result.safety).toBeNull()
	expect(fake.writes).toEqual([])
	expect(namesById(fake)).toEqual(before)
	expect(result.requestAction).toBe('addobj')
	expect(result.requests).toHaveLength(2)
	expect(result.requests[0]).toMatchObject({
		action: 'addobj',
		comp: 'guestservice-list',
	})
	expect(result.requests[0]!.xmlBody).toMatch(/^<guestservice\b/)
	expect(result.requests[0]!.xmlBody).not.toMatch(/\sid\s*=/)
	expect(result.requests[1]).toEqual({
		action: 'addobj',
		comp: 'wlansvc-list',
		xmlBody: result.requestXml,
	})
	expect(result.requestXml).toMatch(/^<wlansvc\b/)
	expect(result.requestXml).not.toMatch(/\sid\s*=/)
	expect(result.requestXml).not.toMatch(/create-time/)
	expect(getAttributeValue(result.requestXml, 'name')).toBe('friendlyguest-2.4')
	expect(getAttributeValue(result.requestXml, 'ssid')).toBe('friendlyguest-2.4')
	expect(getAttributeValue(result.requestXml, 'wlan-bind-24g')).toBe('true')
	expect(getAttributeValue(result.requestXml, 'wlan-bind-5g')).toBe('false')
	expect(getAttributeValue(result.requestXml, 'wlan-bind-6g')).toBe('false')
	expect(getAttributeValue(result.requestXml, 'vlan-id')).toBe('20')
	expect(getAttributeValue(result.requestXml, 'guestservice-id')).toBe(
		'__NEW_GUESTSERVICE_ID__',
	)
	expect(result.requestXml).not.toMatch(ALL_TEST_SECRETS)
	expect(result.requestXml).toMatch(/passphrase="\[redacted\]"/)
})

test('clone of g (id 2) gets its own guestservice; deleting the clone does not remove g guestservice 2', async () => {
	const fake = createFakeController()
	expect(fake.guestservices().entries.map((entry) => entry.id)).toContain('2')
	const created = await cloneWlanById({
		client: fake.client,
		sourceId: '2',
		overrides: {
			name: 'kody-test-delete-me',
			ssid: 'kody-test-delete-me',
			radioBand: '2.4ghz',
			attributes: { 'enable-type': '1' },
		},
	})
	expect(created.created).not.toBeNull()
	const newGuestId = created.created!.attributes['guestservice-id']
	expect(newGuestId).toBeTruthy()
	expect(newGuestId).not.toBe('2')
	expect(fake.guestservices().entries.map((entry) => entry.id)).toContain('2')
	expect(fake.guestservices().entries.map((entry) => entry.id)).toContain(
		newGuestId,
	)
	await deleteWlanById({
		client: fake.client,
		id: created.created!.id,
		expectedName: 'kody-test-delete-me',
	})
	expect(fake.guestservices().entries.map((entry) => entry.id)).toContain('2')
	expect(fake.guestservices().entries.map((entry) => entry.id)).not.toContain(
		newGuestId,
	)
	expect(namesById(fake)).toEqual([
		['1', 'friendlyfamily'],
		['2', 'g'],
		['3', 'friendlyfamily-2.4'],
		['5', 'friendlyguest'],
	])
})

test('delete never removes a guestservice still referenced by another WLAN', async () => {
	const fake = createFakeController()
	await fake.client.request({
		action: 'updobj',
		comp: 'wlansvc-list',
		xmlBody: `<wlansvc id='5' IS_PARTIAL='true' guestservice-id='2'/>`,
	})
	expect(
		fake.list().entries.find((entry) => entry.id === '5')!.attributes[
			'guestservice-id'
		],
	).toBe('2')
	const deleted = await deleteWlanById({
		client: fake.client,
		id: '5',
		expectedName: 'friendlyguest',
	})
	expect(deleted.warnings.join(' ')).toMatch(/still referenced|shared/)
	expect(fake.guestservices().entries.map((entry) => entry.id)).toContain('2')
	expect(
		fake.writes.some(
			(write) =>
				write.comp === 'guestservice-list' &&
				write.action === 'delobj' &&
				/id=['"]2['"]/.test(write.xmlBody),
		),
	).toBe(false)
})

test('dryRun update and delete build the wire request without sending', async () => {
	const fake = createFakeController()
	const update = await updateWlanById({
		client: fake.client,
		id: '5',
		attributes: { 'vlan-id': '30' },
		dryRun: true,
	})
	expect(update.dryRun).toBe(true)
	expect(update.requests).toEqual([
		{
			action: 'updobj',
			comp: 'wlansvc-list',
			xmlBody: "<wlansvc id='5' IS_PARTIAL='true' vlan-id='30'/>",
		},
	])
	const del = await deleteWlanById({
		client: fake.client,
		id: '2',
		expectedName: 'g',
		dryRun: true,
	})
	expect(del.dryRun).toBe(true)
	expect(del.requests).toEqual([
		{
			action: 'delobj',
			comp: 'wlansvc-list',
			xmlBody: "<wlansvc id='2'/>",
		},
		{
			action: 'delobj',
			comp: 'guestservice-list',
			xmlBody: "<guestservice id='2'/>",
		},
	])
	expect(fake.writes).toEqual([])
})
