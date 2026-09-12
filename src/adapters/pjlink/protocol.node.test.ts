import { expect, test } from 'vitest'
import {
	computePjlinkAuthDigest,
	encodePjlinkAvMute,
	encodePjlinkCommand,
	encodePjlinkInput,
	encodePjlinkPowerCommand,
	parsePjlinkAvMute,
	parsePjlinkHandshake,
	parsePjlinkInput,
	parsePjlinkLampStatus,
	parsePjlinkPowerState,
	parsePjlinkResponse,
	PjlinkProtocolError,
} from './protocol.ts'

test('parses a no-auth PJLink handshake', () => {
	expect(parsePjlinkHandshake('PJLINK 0\r')).toEqual({
		authRequired: false,
		random: null,
		raw: 'PJLINK 0',
	})
})

test('parses an authenticated PJLink handshake', () => {
	expect(parsePjlinkHandshake('PJLINK 1 A1B2C3D4')).toEqual({
		authRequired: true,
		random: 'a1b2c3d4',
		raw: 'PJLINK 1 A1B2C3D4',
	})
})

test('rejects an unexpected handshake', () => {
	expect(() => parsePjlinkHandshake('HELLO')).toThrow(PjlinkProtocolError)
})

test('encodes a no-auth power-off command with CR framing', () => {
	expect(
		encodePjlinkCommand({
			command: 'POWR',
			parameter: encodePjlinkPowerCommand('off'),
		}),
	).toBe('%1POWR 0\r')
})

test('prefixes the command with the MD5 auth digest', () => {
	const digest = computePjlinkAuthDigest({
		random: 'a1b2c3d4',
		password: 'secret',
	})
	expect(digest).toHaveLength(32)
	expect(
		encodePjlinkCommand({
			command: 'POWR',
			parameter: '1',
			authDigest: digest,
		}),
	).toBe(`${digest}%1POWR 1\r`)
})

test('parses power query and command responses', () => {
	expect(parsePjlinkResponse('%1POWR=0').value).toBe('0')
	expect(parsePjlinkPowerState('0')).toBe('standby')
	expect(parsePjlinkPowerState('1')).toBe('on')
	expect(parsePjlinkPowerState('2')).toBe('cooling')
	expect(parsePjlinkPowerState('3')).toBe('warming')
	expect(parsePjlinkResponse('%1POWR=OK').value).toBe('OK')
})

test('maps PJLink error codes to protocol errors', () => {
	expect(() => parsePjlinkResponse('%1POWR=ERR3')).toThrow(/unavailable time/)
	expect(() => parsePjlinkResponse('PJLINK ERRA')).toThrow(
		/authentication failed/,
	)
})

test('encodes and parses INPT and AVMT', () => {
	expect(encodePjlinkInput({ inputClass: 'digital', channel: 1 })).toBe('31')
	expect(parsePjlinkInput('31')).toEqual({
		inputClass: 'digital',
		channel: 1,
		code: '31',
	})
	expect(encodePjlinkAvMute('av-on')).toBe('31')
	expect(parsePjlinkAvMute('30')).toBe('av-off')
})

test('parses one or more LAMP entries', () => {
	expect(parsePjlinkLampStatus('123 1')).toEqual([{ hours: 123, on: true }])
	expect(parsePjlinkLampStatus('10 0 20 1')).toEqual([
		{ hours: 10, on: false },
		{ hours: 20, on: true },
	])
})
