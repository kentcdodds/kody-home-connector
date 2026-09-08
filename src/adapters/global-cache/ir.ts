export type NecPulseProfile = {
	freq: number
	headerOn: number
	headerOff: number
	mark: number
	space0: number
	space1: number
	gap: number
}

/** Learned MROCIOA HDMI-switch timing from iTach get_IRL. */
export const hdmiSwitchPulseProfile: NecPulseProfile = {
	freq: 37878,
	headerOn: 342,
	headerOff: 170,
	mark: 22,
	space0: 21,
	space1: 64,
	gap: 1502,
}

export const standardNecPulseProfile: NecPulseProfile = {
	freq: 38000,
	headerOn: 342,
	headerOff: 171,
	mark: 21,
	space0: 21,
	space1: 64,
	gap: 1520,
}

function microsecondsToPeriods(us: number, freq: number) {
	return Math.max(1, Math.round((us * freq) / 1_000_000))
}

export function encodeNecPulses(input: {
	address: number
	command: number
	address2?: number
	profile?: NecPulseProfile
}): Array<number> {
	const profile = input.profile ?? standardNecPulseProfile
	const address2 =
		input.address2 === undefined ? ~input.address & 0xff : input.address2 & 0xff
	const bytes = [
		input.address & 0xff,
		address2,
		input.command & 0xff,
		~input.command & 0xff,
	]
	const pulses = [profile.headerOn, profile.headerOff]
	for (const byte of bytes) {
		for (let bit = 0; bit < 8; bit += 1) {
			pulses.push(
				profile.mark,
				(byte >> bit) & 1 ? profile.space1 : profile.space0,
			)
		}
	}
	pulses.push(profile.mark, profile.gap)
	return pulses
}

export function flipperRawToGcPulses(
	raw: string,
	freq = standardNecPulseProfile.freq,
): Array<number> {
	const pulses: Array<number> = []
	for (const token of raw.trim().split(/\s+/)) {
		const microseconds = Number(token)
		if (!Number.isFinite(microseconds) || microseconds <= 0) {
			continue
		}
		if (microseconds > 20_000 && pulses.length > 0) {
			break
		}
		pulses.push(microsecondsToPeriods(microseconds, freq))
	}
	if (pulses.length % 2 === 1) {
		pulses.push(microsecondsToPeriods(40_000, freq))
	}
	return pulses
}

export function buildSendirCommand(input: {
	connector: string
	id?: number
	freq: number
	repeat?: number
	pulses: Array<number>
}): string {
	if (input.pulses.length === 0 || input.pulses.length % 2 === 1) {
		throw new Error(
			'Global Cache sendir pulses must be a non-empty even on/off list.',
		)
	}
	const id = input.id ?? 1
	const repeat = input.repeat ?? 2
	return `sendir,${input.connector},${String(id)},${String(input.freq)},${String(repeat)},1,${input.pulses.join(',')}`
}
