import { expect, test } from 'vitest'
import { detectOverwriteFirstWlanBug } from './wlan-ops.ts'
import {
	buildPartialWlanUpdateXml,
	countTopLevelWlansvcElements,
	diffWlanLists,
	extractWlansvcEntries,
	findDuplicateIds,
	removeRootIdAttribute,
	xmlBodyLooksLikeFullObjectWlanWrite,
	xmlBodyLooksLikeFullWlanListWrite,
} from './wlan-xml.ts'

const sampleListXml = `
<ajax-response>
  <response status="ok">
    <wlansvc-list>
      <wlansvc id='1' name='friendlyfamily' ssid='friendlyfamily' vlan-id='1' client-isolation='disabled' encryption='wpa2'>
        <wpa cipher='aes' passphrase='family-secret'/>
      </wlansvc>
      <wlansvc id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='10' client-isolation='enabled' is-guest='true' usage='guest' encryption='wpa2'>
        <wpa cipher='aes' passphrase='guest-secret'/>
        <guest-access portal='true'/>
      </wlansvc>
      <wlansvc id='7' name='iot' ssid='iot' vlan-id='30' radio='Both' encryption='wpa2'>
        <wpa cipher='aes' passphrase='iot-secret'/>
      </wlansvc>
    </wlansvc-list>
  </response>
</ajax-response>
`.trim()

test('extractWlansvcEntries preserves id, guest portal children, and isolation', () => {
	const entries = extractWlansvcEntries(sampleListXml)
	expect(entries).toHaveLength(3)
	expect(entries.map((entry) => entry.id)).toEqual(['1', '5', '7'])
	const guest = entries.find((entry) => entry.id === '5')
	expect(guest?.attributes['vlan-id']).toBe('10')
	expect(guest?.attributes['client-isolation']).toBe('enabled')
	expect(guest?.rawXml).toContain("<guest-access portal='true'/>")
	expect(guest?.rawXml).toContain("name='friendlyguest'")
})

test('buildPartialWlanUpdateXml sends only id + changed attrs + IS_PARTIAL', () => {
	expect(
		buildPartialWlanUpdateXml({
			id: '5',
			attributes: { 'vlan-id': '20' },
		}),
	).toBe("<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>")
})

test('removeRootIdAttribute strips id for clone creates', () => {
	const guest = extractWlansvcEntries(sampleListXml).find(
		(entry) => entry.id === '5',
	)
	expect(guest).toBeDefined()
	const sansId = removeRootIdAttribute(guest!.rawXml)
	expect(sansId).not.toMatch(/\sid\s*=/)
	expect(sansId).toContain("name='friendlyguest'")
	expect(sansId).toContain("<guest-access portal='true'/>")
})

test('xmlBodyLooksLikeFullWlanListWrite catches the dangerous whole-list pattern', () => {
	expect(
		xmlBodyLooksLikeFullWlanListWrite(
			"<wlansvc-list><wlansvc id='1'/><wlansvc id='5'/></wlansvc-list>",
		),
	).toBe(true)
	expect(
		xmlBodyLooksLikeFullWlanListWrite(
			"<wlansvc id='1' name='a'/><wlansvc id='5' name='b'/>",
		),
	).toBe(true)
	expect(
		xmlBodyLooksLikeFullWlanListWrite(
			"<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>",
		),
	).toBe(false)
	expect(countTopLevelWlansvcElements("<wlansvc id='5'/>")).toBe(1)
})

test('xmlBodyLooksLikeFullObjectWlanWrite catches non-partial single-object writes', () => {
	expect(
		xmlBodyLooksLikeFullObjectWlanWrite(
			"<wlansvc id='5' name='friendlyguest' vlan-id='20'></wlansvc>",
		),
	).toBe(true)
	expect(
		xmlBodyLooksLikeFullObjectWlanWrite(
			"<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>",
		),
	).toBe(false)
	expect(
		xmlBodyLooksLikeFullObjectWlanWrite(
			"<wlansvc id='5' DELETE='true' IS_PARTIAL='true'/>",
		),
	).toBe(false)
})

test('extractWlansvcEntries rejects id-less entries', () => {
	expect(() =>
		extractWlansvcEntries(
			"<ajax-response><wlansvc name='orphan' ssid='orphan'/></ajax-response>",
		),
	).toThrow(/without an id/i)
})

test('regression: overwrite-first-WLAN bug produces duplicate id 5 and unexpected id 1 change', () => {
	const before = extractWlansvcEntries(sampleListXml)
	// Simulate the Oct 12 failure: setconf meant for friendlyguest (id 5) was
	// applied to list position 0, copying friendlyguest (including id='5') over
	// friendlyfamily. Result: two entries with id 5, no id 1.
	const afterXml = `
<ajax-response>
  <wlansvc-list>
    <wlansvc id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='20' client-isolation='enabled' is-guest='true' usage='guest' encryption='wpa2'>
      <wpa cipher='aes' passphrase='guest-secret'/>
      <guest-access portal='true'/>
    </wlansvc>
    <wlansvc id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='10' client-isolation='enabled' is-guest='true' usage='guest' encryption='wpa2'>
      <wpa cipher='aes' passphrase='guest-secret'/>
      <guest-access portal='true'/>
    </wlansvc>
    <wlansvc id='7' name='iot' ssid='iot' vlan-id='30' radio='Both' encryption='wpa2'>
      <wpa cipher='aes' passphrase='iot-secret'/>
    </wlansvc>
  </wlansvc-list>
</ajax-response>
`.trim()
	const after = extractWlansvcEntries(afterXml)
	expect(findDuplicateIds(after)).toEqual(['5'])

	const diff = diffWlanLists({
		before,
		after,
		allowedChangedIds: new Set(['5']),
		allowedAddedIds: new Set(),
	})
	expect(diff.ok).toBe(false)
	expect(diff.duplicateIds).toContain('5')
	expect(diff.missingIds).toContain('1')
	expect(diff.summary).toMatch(/duplicate|missing/i)

	// Same detection via the ops helper used by tests documenting the incident.
	const bugDiff = detectOverwriteFirstWlanBug({
		before,
		after,
		intendedTargetId: '5',
	})
	expect(bugDiff.ok).toBe(false)
})

test('diffWlanLists allows only the intended target id to change', () => {
	const before = extractWlansvcEntries(sampleListXml)
	const afterXml = sampleListXml.replace(
		"id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='10'",
		"id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='20'",
	)
	const after = extractWlansvcEntries(afterXml)
	const okDiff = diffWlanLists({
		before,
		after,
		allowedChangedIds: new Set(['5']),
	})
	expect(okDiff.ok).toBe(true)

	const badDiff = diffWlanLists({
		before,
		after,
		allowedChangedIds: new Set(['1']),
	})
	expect(badDiff.ok).toBe(false)
	expect(badDiff.changedUnexpectedIds).toContain('5')
})
