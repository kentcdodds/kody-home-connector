/**
 * Sony IRCC-IP command tables for the court UHD Blu-ray player.
 *
 * BD1 codes are encoded the way sonyapilib builds a category command list:
 * `base64(pack(">IIIB", fmt=3, category=7258, code, 3))`. Category 7258 is
 * `IrccCategory.BD1`. Live players can replace these after pairing via
 * `getRemoteCommandList` / `getRemoteControllerInfo`.
 *
 * TV-style codes are the widely published Sony IRCC-IP / Bravia table. Some
 * UHD players accept those as well; `bluray_press` can send either family.
 *
 * Do not treat these as verified against Kent's court unit — the player is
 * usually unplugged. Codes are stubbed from public Sony IRCC tables.
 */

export const sonyIrccBd1CategoryId = 7258
export const sonyIrccBd1Format = 3

export const sonyIrccBd1CommandIds = {
	power: 21,
	eject: 22,
	stop: 24,
	pause: 25,
	play: 26,
	rewind: 27,
	forward: 28,
	popupMenu: 41,
	topMenu: 44,
	up: 57,
	down: 58,
	left: 59,
	right: 60,
	enter: 61,
	options: 63,
	display: 65,
	home: 66,
	back: 67,
	next: 86,
	prev: 87,
} as const

export const sonyIrccTvCodes = {
	power: 'AAAAAQAAAAEAAAAVAw==',
	powerOn: 'AAAAAQAAAAEAAAAuAw==',
	powerOff: 'AAAAAQAAAAEAAAAvAw==',
	home: 'AAAAAQAAAAEAAABgAw==',
	enter: 'AAAAAQAAAAEAAABlAw==',
	up: 'AAAAAQAAAAEAAAB0Aw==',
	down: 'AAAAAQAAAAEAAAB1Aw==',
	left: 'AAAAAQAAAAEAAAA0Aw==',
	right: 'AAAAAQAAAAEAAAAzAw==',
	back: 'AAAAAgAAAJcAAAAjAw==',
	options: 'AAAAAgAAAJcAAAA2Aw==',
	play: 'AAAAAgAAAJcAAAAaAw==',
	pause: 'AAAAAgAAAJcAAAAZAw==',
	stop: 'AAAAAgAAAJcAAAAYAw==',
	rewind: 'AAAAAgAAAJcAAAAbAw==',
	forward: 'AAAAAgAAAJcAAAAcAw==',
	prev: 'AAAAAgAAAJcAAAA8Aw==',
	next: 'AAAAAgAAAJcAAAA9Aw==',
	eject: 'AAAAAgAAAJcAAABIAw==',
	display: 'AAAAAQAAAAEAAAA6Aw==',
} as const

export type SonyIrccCommandName =
	| 'play'
	| 'pause'
	| 'stop'
	| 'eject'
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'enter'
	| 'home'
	| 'back'
	| 'options'
	| 'display'
	| 'rewind'
	| 'forward'
	| 'prev'
	| 'next'
	| 'power'
	| 'powerOn'
	| 'powerOff'
	| 'topMenu'
	| 'popupMenu'

export const sonyIrccCommandNames = [
	'play',
	'pause',
	'stop',
	'eject',
	'up',
	'down',
	'left',
	'right',
	'enter',
	'home',
	'back',
	'options',
	'display',
	'rewind',
	'forward',
	'prev',
	'next',
	'power',
	'powerOn',
	'powerOff',
	'topMenu',
	'popupMenu',
] as const satisfies ReadonlyArray<SonyIrccCommandName>

export function encodeSonyIrccBd1Code(
	code: number,
	fmt: number = sonyIrccBd1Format,
	categoryId: number = sonyIrccBd1CategoryId,
) {
	const buffer = Buffer.alloc(13)
	buffer.writeUInt32BE(fmt, 0)
	buffer.writeUInt32BE(categoryId, 4)
	buffer.writeUInt32BE(code, 8)
	buffer.writeUInt8(3, 12)
	return buffer.toString('base64')
}

function buildBd1Codes() {
	return {
		power: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.power),
		powerOn: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.power),
		powerOff: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.power),
		eject: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.eject),
		stop: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.stop),
		pause: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.pause),
		play: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.play),
		rewind: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.rewind),
		forward: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.forward),
		popupMenu: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.popupMenu),
		topMenu: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.topMenu),
		up: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.up),
		down: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.down),
		left: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.left),
		right: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.right),
		enter: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.enter),
		options: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.options),
		display: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.display),
		home: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.home),
		back: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.back),
		next: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.next),
		prev: encodeSonyIrccBd1Code(sonyIrccBd1CommandIds.prev),
	} as const satisfies Record<SonyIrccCommandName, string>
}

export const sonyIrccBd1Codes = buildBd1Codes()

export function getSonyIrccCode(
	command: SonyIrccCommandName,
	family: 'bd1' | 'tv' = 'bd1',
) {
	if (family === 'tv') {
		const tvCode = sonyIrccTvCodes[command as keyof typeof sonyIrccTvCodes]
		if (tvCode) return tvCode
	}
	return sonyIrccBd1Codes[command]
}

export function isSonyIrccCommandName(
	value: string,
): value is SonyIrccCommandName {
	return (sonyIrccCommandNames as ReadonlyArray<string>).includes(value)
}

export function buildSonyIrccSoapEnvelope(irccCode: string) {
	return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">
      <IRCCCode>${irccCode}</IRCCCode>
    </u:X_SendIRCC>
  </s:Body>
</s:Envelope>`
}

export const sonyIrccSoapAction =
	'"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'
