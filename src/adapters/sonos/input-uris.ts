function rinconId(udn: string) {
	return udn.replace(/^uuid:/i, '')
}

/** Analog line-in. Used by Connect, Port, Amp analog input. */
export function buildSonosLineInUri(udn: string) {
	return `x-rincon-stream:${rinconId(udn)}`
}

/**
 * HDMI/TV/ARC (SPDIF) input on Sonos home-theater devices (Amp, Beam, Arc,
 * Playbar, Playbase). Same URI SoCo and Home Assistant use for "TV".
 *
 * Do not use `x-sonos-ht:spdif` or `x-sonos-ht:hdmi` — Sport Court Amp
 * (`RINCON_804AF2A8DB1F01400`) returns UPnP 714 for those. The working form is
 * `x-sonos-htastream:RINCON_…:spdif`. ContentDirectory `AI:` only lists analog
 * line-in; TV is not an AudioIn object.
 */
export function buildSonosTvInputUri(udn: string) {
	return `x-sonos-htastream:${rinconId(udn)}:spdif`
}
