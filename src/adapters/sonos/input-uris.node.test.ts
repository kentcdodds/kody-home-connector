import { expect, test } from 'vitest'
import { buildSonosLineInUri, buildSonosTvInputUri } from './input-uris.ts'

test('Amp HT TV/HDMI URI is htastream SPDIF, not analog line-in', () => {
	const udn = 'uuid:RINCON_804AF2A8DB1F01400'
	const lineIn = buildSonosLineInUri(udn)
	const tv = buildSonosTvInputUri(udn)

	expect(lineIn).toBe('x-rincon-stream:RINCON_804AF2A8DB1F01400')
	expect(tv).toBe('x-sonos-htastream:RINCON_804AF2A8DB1F01400:spdif')
	expect(tv).not.toBe(lineIn)
})

test('input URI helpers accept a bare RINCON id', () => {
	const rincon = 'RINCON_804AF2A8DB1F01400'
	expect(buildSonosLineInUri(rincon)).toBe(`x-rincon-stream:${rincon}`)
	expect(buildSonosTvInputUri(rincon)).toBe(
		`x-sonos-htastream:${rincon}:spdif`,
	)
})
