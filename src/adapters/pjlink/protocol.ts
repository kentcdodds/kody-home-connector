import { createHash } from 'node:crypto'

export const pjlinkDefaultPort = 4352
export const pjlinkCommandTerminator = '\r'

export const pjlinkPowerStates = [
	'standby',
	'on',
	'cooling',
	'warming',
] as const
export type PjlinkPowerState = (typeof pjlinkPowerStates)[number]

export const pjlinkPowerCommands = ['off', 'on'] as const
export type PjlinkPowerCommand = (typeof pjlinkPowerCommands)[number]

export const pjlinkInputClasses = [
	'rgb',
	'video',
	'digital',
	'storage',
	'network',
] as const
export type PjlinkInputClass = (typeof pjlinkInputClasses)[number]

export const pjlinkAvMuteModes = [
	'video-off',
	'video-on',
	'audio-off',
	'audio-on',
	'av-off',
	'av-on',
] as const
export type PjlinkAvMuteMode = (typeof pjlinkAvMuteModes)[number]

export const pjlinkErrorCodes = [
	'ERR1',
	'ERR2',
	'ERR3',
	'ERR4',
	'ERRA',
] as const
export type PjlinkErrorCode = (typeof pjlinkErrorCodes)[number]

export type PjlinkHandshake = {
	authRequired: boolean
	random: string | null
	raw: string
}

export type PjlinkCommandName =
	| 'POWR'
	| 'INPT'
	| 'AVMT'
	| 'LAMP'
	| 'ERST'
	| 'NAME'
	| 'INF1'
	| 'INF2'
	| 'INFO'
	| 'CLSS'
	| 'INST'

export type PjlinkParsedResponse = {
	command: PjlinkCommandName | null
	value: string
	raw: string
}

export class PjlinkProtocolError extends Error {
	readonly code: PjlinkErrorCode | 'invalid_handshake' | 'invalid_response'
	readonly raw: string | null

	constructor(input: {
		code: PjlinkErrorCode | 'invalid_handshake' | 'invalid_response'
		message: string
		raw?: string | null
	}) {
		super(input.message)
		this.name = 'PjlinkProtocolError'
		this.code = input.code
		this.raw = input.raw ?? null
	}
}

export function isPjlinkProtocolError(
	error: unknown,
): error is PjlinkProtocolError {
	return error instanceof PjlinkProtocolError
}

export function normalizePjlinkLine(value: string) {
	return value.replaceAll('\n', '').replaceAll('\r', '').trim()
}

export function parsePjlinkHandshake(line: string): PjlinkHandshake {
	const raw = normalizePjlinkLine(line)
	const noAuth = /^PJLINK\s+0$/i.exec(raw)
	if (noAuth) {
		return {
			authRequired: false,
			random: null,
			raw,
		}
	}
	const withAuth = /^PJLINK\s+1\s+([0-9A-Fa-f]{8})$/i.exec(raw)
	if (withAuth) {
		return {
			authRequired: true,
			random: (withAuth[1] ?? '').toLowerCase(),
			raw,
		}
	}
	if (/^PJLINK\s+ERRA$/i.test(raw)) {
		throw new PjlinkProtocolError({
			code: 'ERRA',
			message: 'PJLink authentication failed (ERRA).',
			raw,
		})
	}
	throw new PjlinkProtocolError({
		code: 'invalid_handshake',
		message: `Unexpected PJLink handshake: ${raw || '<empty>'}`,
		raw,
	})
}

export function computePjlinkAuthDigest(input: {
	random: string
	password: string
}) {
	return createHash('md5')
		.update(`${input.random}${input.password}`, 'utf8')
		.digest('hex')
}

export function encodePjlinkCommand(input: {
	command: PjlinkCommandName
	parameter: string
	authDigest?: string | null
}) {
	const body = `%1${input.command} ${input.parameter}`
	const prefix = input.authDigest?.trim() ?? ''
	return `${prefix}${body}${pjlinkCommandTerminator}`
}

export function parsePjlinkResponse(line: string): PjlinkParsedResponse {
	const raw = normalizePjlinkLine(line)
	if (/^PJLINK\s+ERRA$/i.test(raw)) {
		throw new PjlinkProtocolError({
			code: 'ERRA',
			message: 'PJLink authentication failed (ERRA).',
			raw,
		})
	}
	const match = /^%1([A-Z]{4})=(.+)$/.exec(raw)
	if (!match) {
		throw new PjlinkProtocolError({
			code: 'invalid_response',
			message: `Unexpected PJLink response: ${raw || '<empty>'}`,
			raw,
		})
	}
	const command = match[1] as PjlinkCommandName
	const value = match[2] ?? ''
	if (
		value === 'ERR1' ||
		value === 'ERR2' ||
		value === 'ERR3' ||
		value === 'ERR4'
	) {
		throw new PjlinkProtocolError({
			code: value,
			message: describePjlinkError(value, command),
			raw,
		})
	}
	return { command, value, raw }
}

export function describePjlinkError(
	code: PjlinkErrorCode,
	command?: PjlinkCommandName | null,
) {
	const commandLabel = command ? ` for ${command}` : ''
	switch (code) {
		case 'ERR1':
			return `PJLink undefined command${commandLabel}.`
		case 'ERR2':
			return `PJLink out-of-parameter${commandLabel}.`
		case 'ERR3':
			return `PJLink unavailable time${commandLabel} (projector is busy or cooling).`
		case 'ERR4':
			return `PJLink projector failure${commandLabel}.`
		case 'ERRA':
			return 'PJLink authentication failed (ERRA).'
		default: {
			const exhaustive: never = code
			return `Unhandled PJLink error ${String(exhaustive)}.`
		}
	}
}

export function encodePjlinkPowerCommand(command: PjlinkPowerCommand) {
	switch (command) {
		case 'off':
			return '0'
		case 'on':
			return '1'
		default: {
			const exhaustive: never = command
			throw new Error(`Unhandled PJLink power command: ${String(exhaustive)}`)
		}
	}
}

export function parsePjlinkPowerState(value: string): PjlinkPowerState {
	switch (value) {
		case '0':
			return 'standby'
		case '1':
			return 'on'
		case '2':
			return 'cooling'
		case '3':
			return 'warming'
		default:
			throw new PjlinkProtocolError({
				code: 'invalid_response',
				message: `Unexpected PJLink power status: ${value}`,
				raw: value,
			})
	}
}

export function encodePjlinkInput(input: {
	inputClass: PjlinkInputClass
	channel: number
}) {
	if (
		!Number.isInteger(input.channel) ||
		input.channel < 1 ||
		input.channel > 9
	) {
		throw new Error('PJLink input channel must be an integer from 1 to 9.')
	}
	const classDigit = pjlinkInputClassDigit(input.inputClass)
	return `${classDigit}${String(input.channel)}`
}

export function parsePjlinkInput(value: string): {
	inputClass: PjlinkInputClass
	channel: number
	code: string
} {
	const match = /^([1-5])([1-9])$/.exec(value.trim())
	if (!match) {
		throw new PjlinkProtocolError({
			code: 'invalid_response',
			message: `Unexpected PJLink input: ${value}`,
			raw: value,
		})
	}
	return {
		inputClass: pjlinkInputClassFromDigit(match[1] ?? ''),
		channel: Number(match[2]),
		code: value.trim(),
	}
}

export function encodePjlinkAvMute(mode: PjlinkAvMuteMode) {
	switch (mode) {
		case 'video-off':
			return '10'
		case 'video-on':
			return '11'
		case 'audio-off':
			return '20'
		case 'audio-on':
			return '21'
		case 'av-off':
			return '30'
		case 'av-on':
			return '31'
		default: {
			const exhaustive: never = mode
			throw new Error(`Unhandled PJLink AV mute mode: ${String(exhaustive)}`)
		}
	}
}

export function parsePjlinkAvMute(value: string): PjlinkAvMuteMode {
	switch (value.trim()) {
		case '10':
			return 'video-off'
		case '11':
			return 'video-on'
		case '20':
			return 'audio-off'
		case '21':
			return 'audio-on'
		case '30':
			return 'av-off'
		case '31':
			return 'av-on'
		default:
			throw new PjlinkProtocolError({
				code: 'invalid_response',
				message: `Unexpected PJLink AV mute status: ${value}`,
				raw: value,
			})
	}
}

export function parsePjlinkLampStatus(value: string): Array<{
	hours: number
	on: boolean
}> {
	const tokens = value.trim().split(/\s+/).filter(Boolean)
	if (tokens.length === 0 || tokens.length % 2 !== 0) {
		throw new PjlinkProtocolError({
			code: 'invalid_response',
			message: `Unexpected PJLink lamp status: ${value}`,
			raw: value,
		})
	}
	const lamps: Array<{ hours: number; on: boolean }> = []
	for (let index = 0; index < tokens.length; index += 2) {
		const hours = Number(tokens[index])
		const onFlag = tokens[index + 1]
		if (!Number.isFinite(hours) || (onFlag !== '0' && onFlag !== '1')) {
			throw new PjlinkProtocolError({
				code: 'invalid_response',
				message: `Unexpected PJLink lamp status: ${value}`,
				raw: value,
			})
		}
		lamps.push({
			hours,
			on: onFlag === '1',
		})
	}
	return lamps
}

function pjlinkInputClassDigit(inputClass: PjlinkInputClass) {
	switch (inputClass) {
		case 'rgb':
			return '1'
		case 'video':
			return '2'
		case 'digital':
			return '3'
		case 'storage':
			return '4'
		case 'network':
			return '5'
		default: {
			const exhaustive: never = inputClass
			throw new Error(`Unhandled PJLink input class: ${String(exhaustive)}`)
		}
	}
}

function pjlinkInputClassFromDigit(digit: string): PjlinkInputClass {
	switch (digit) {
		case '1':
			return 'rgb'
		case '2':
			return 'video'
		case '3':
			return 'digital'
		case '4':
			return 'storage'
		case '5':
			return 'network'
		default:
			throw new PjlinkProtocolError({
				code: 'invalid_response',
				message: `Unexpected PJLink input class digit: ${digit}`,
				raw: digit,
			})
	}
}
