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
 */
export function buildSonosTvInputUri(udn: string) {
	return `x-sonos-htastream:${rinconId(udn)}:spdif`
}
