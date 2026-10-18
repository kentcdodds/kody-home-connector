import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import {
	buildPartialWlanUpdateXml,
	canonicalWlanFingerprint,
	findUnrestorableSecrets,
	parseWlansvcList,
	redactSecretsInXmlText,
	redactWlanSecrets,
	removeRootAttributes,
	wlanXmlContainsExpected,
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

function fixture(name: string) {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

test('redacted controller fixture: pre-incident wlansvc-list parses cleanly', () => {
	const parsed = parseWlansvcList(
		fixture('wlansvc-list-before-clone-incident.xml'),
	)
	expect(parsed.anomalies).toEqual([])
	expect(parsed.duplicateIds).toEqual([])
	expect(parsed.entries.map((entry) => [entry.id, entry.name])).toEqual([
		['1', 'friendlyfamily'],
		['2', 'g'],
		['3', 'friendlyfamily-2.4'],
		['5', 'friendlyguest'],
	])
	// Real radio flags live on wlan-bind-*; there is no `radio` attribute.
	const family = parsed.entries[0]!
	expect(family.attributes['wlan-bind-24g']).toBe('true')
	expect(family.attributes['wlan-bind-5g']).toBe('true')
	expect(family.attributes['wlan-bind-6g']).toBe('true')
	expect('radio' in family.attributes).toBe(false)
})

test('redacted controller fixture: Oct 17 post-write list has an id-less first entry', () => {
	const xml = fixture('wlansvc-list-after-clone-incident.xml')
	// Strict parsing is what made every WLAN tool refuse.
	expect(() => extractWlansvcEntries(xml)).toThrow(/without an id/i)
	// Lenient parsing keeps reads working and surfaces the damage.
	const parsed = parseWlansvcList(xml)
	expect(parsed.entries.map((entry) => entry.id)).toEqual(['2', '3', '5'])
	expect(parsed.anomalies).toHaveLength(1)
	expect(parsed.anomalies[0]).toMatchObject({
		index: 0,
		kind: 'missing-id',
		name: 'friendlyguest-2.4',
		ssid: 'friendlyguest-2.4',
	})
	// The overwritten slot took the clone payload's radio flags.
	expect(parsed.anomalies[0]!.rawXml).toContain('wlan-bind-5g="false"')
	// friendlyfamily (id 1) is gone.
	expect(parsed.entries.some((entry) => entry.name === 'friendlyfamily')).toBe(
		false,
	)
})

test('redacted fixtures carry no secret values', () => {
	for (const name of [
		'wlansvc-list-before-clone-incident.xml',
		'wlansvc-list-after-clone-incident.xml',
	]) {
		const xml = fixture(name)
		for (const match of xml.matchAll(
			/\s((?:x-)?(?:sae-)?passphrase|(?:x-)?guest-pass)="([^"]*)"/g,
		)) {
			expect(match[2]).toBe('')
		}
		expect(redactSecretsInXmlText(xml)).toBe(xml)
	}
})

test('redactSecretsInXmlText hides passphrases, x- twins and guest-pass anywhere', () => {
	const xml =
		"<wlansvc id='1' guest-pass='gp-secret' name='n'><wpa cipher='aes' x-passphrase='obf' passphrase='psk-secret' sae-passphrase='' dynamic-psk='disabled'/></wlansvc>"
	const redacted = redactSecretsInXmlText(xml)
	expect(redacted).not.toMatch(/gp-secret|psk-secret|obf/)
	expect(redacted).toContain("passphrase='[redacted]'")
	expect(redacted).toContain("sae-passphrase=''")
	expect(redacted).toContain("dynamic-psk='disabled'")
	const entry = parseWlansvcList(xml).entries[0]!
	const safe = redactWlanSecrets(entry)
	expect(safe.attributes['guest-pass']).toBe('[redacted]')
	expect(safe.rawXml).not.toMatch(/gp-secret|psk-secret/)
})

test('findUnrestorableSecrets flags PSK WLANs whose passphrase was not captured', () => {
	const decrypted = parseWlansvcList(
		"<wlansvc id='1' name='a' encryption='wpa2' authentication='open'><wpa cipher='aes' x-passphrase='p' passphrase='p'/></wlansvc>" +
			"<wlansvc id='2' name='b' encryption='wpa2' authentication='open'><wpa cipher='aes' sae-passphrase=''/></wlansvc>" +
			"<wlansvc id='3' name='c' encryption='wpa3' authentication='open'><wpa cipher='aes' passphrase='p'/></wlansvc>" +
			"<wlansvc id='4' name='d' encryption='none' authentication='open'/>" +
			"<wlansvc id='5' name='e' encryption='wpa2' authentication='802.1x-eap'><wpa cipher='aes'/></wlansvc>",
	).entries
	expect(decrypted.map((entry) => findUnrestorableSecrets(entry))).toEqual([
		[],
		['WPA passphrase missing from snapshot'],
		['SAE passphrase missing from snapshot'],
		[],
		[],
	])
})

test('canonicalWlanFingerprint ignores attribute order, quote style and x- twins', () => {
	const a =
		"<wlansvc id='1' name='a' vlan-id='1'><wpa cipher='aes' x-passphrase='obf1' passphrase='p'/></wlansvc>"
	const b =
		'<wlansvc vlan-id="1" name="a" id="1"><wpa passphrase="p" x-passphrase="obf2" cipher="aes" /></wlansvc>'
	expect(canonicalWlanFingerprint(a)).toBe(canonicalWlanFingerprint(b))
	const c = b.replace('passphrase="p"', 'passphrase="q"')
	expect(canonicalWlanFingerprint(a)).not.toBe(canonicalWlanFingerprint(c))
	expect(
		canonicalWlanFingerprint(removeRootAttributes(a, ['id']), {
			ignoreRootAttributes: ['id'],
		}),
	).toBe(
		canonicalWlanFingerprint(b.replace(' id="1"', ' id="9"'), {
			ignoreRootAttributes: ['id'],
		}),
	)
})

test('wlanXmlContainsExpected never echoes secret values in mismatches', () => {
	const result = wlanXmlContainsExpected({
		expectedXml: "<wlansvc name='a'><wpa passphrase='right-secret'/></wlansvc>",
		actualXml:
			"<wlansvc name='a' extra='1'><wpa passphrase='wrong-secret'/></wlansvc>",
	})
	expect(result.ok).toBe(false)
	if (!result.ok) {
		expect(result.mismatch).toContain('passphrase differs')
		expect(result.mismatch).not.toMatch(/right-secret|wrong-secret/)
	}
	expect(
		wlanXmlContainsExpected({
			expectedXml: "<wlansvc name='a'/>",
			actualXml: "<wlansvc name='a' id='7' create-time='1'/>",
		}).ok,
	).toBe(true)
})
