import {
	encodePjlinkAvMute,
	encodePjlinkInput,
	encodePjlinkPowerCommand,
	parsePjlinkAvMute,
	parsePjlinkInput,
	type PjlinkAvMuteMode,
	type PjlinkCommandName,
	type PjlinkHandshake,
	type PjlinkInputClass,
	type PjlinkPowerState,
} from './protocol.ts'
import { PjlinkUnreachableError } from './client.ts'
import { courtOptomaDefaults, type PjlinkCommandClient } from './types.ts'

export type MockPjlinkProjectorState = {
	host: string
	port: number
	name: string
	manufacturer: string
	model: string
	macAddress: string
	authRequired: boolean
	password: string | null
	power: PjlinkPowerState
	inputClass: PjlinkInputClass
	channel: number
	avMute: PjlinkAvMuteMode
	lampHours: number
	lampOn: boolean
	info: string
	pjlinkClass: string
	reachable: boolean
}

const courtMockHost = courtOptomaDefaults.host

function createDefaultCourtProjector(): MockPjlinkProjectorState {
	return {
		host: courtOptomaDefaults.host,
		port: courtOptomaDefaults.port,
		name: courtOptomaDefaults.name,
		manufacturer: 'Optoma',
		model: 'ZK810TST',
		macAddress: courtOptomaDefaults.macAddress,
		authRequired: false,
		password: null,
		power: 'standby',
		inputClass: 'digital',
		channel: 1,
		avMute: 'av-off',
		lampHours: 123,
		lampOn: false,
		info: 'Court cage Optoma',
		pjlinkClass: '1',
		reachable: true,
	}
}

let mockProjectors = new Map<string, MockPjlinkProjectorState>([
	[courtMockHost, createDefaultCourtProjector()],
])

export function resetMockPjlinkState() {
	mockProjectors = new Map([[courtMockHost, createDefaultCourtProjector()]])
}

export function getMockPjlinkProjectors() {
	return [...mockProjectors.values()].map((projector) => ({ ...projector }))
}

export function setMockPjlinkReachable(host: string, reachable: boolean) {
	const projector = mockProjectors.get(host)
	if (!projector) return
	projector.reachable = reachable
}

function requireProjector(host: string) {
	const projector = mockProjectors.get(host)
	if (!projector) {
		throw new Error(`No mock PJLink projector is registered at ${host}.`)
	}
	return projector
}

function handleMockCommand(
	projector: MockPjlinkProjectorState,
	command: string,
	parameter: string,
): string {
	const name = command as PjlinkCommandName
	switch (name) {
		case 'POWR':
			if (parameter === '?') {
				switch (projector.power) {
					case 'standby':
						return '0'
					case 'on':
						return '1'
					case 'cooling':
						return '2'
					case 'warming':
						return '3'
					default: {
						const exhaustive: never = projector.power
						throw new Error(
							`Unhandled mock PJLink power state: ${String(exhaustive)}`,
						)
					}
				}
			}
			if (parameter === encodePjlinkPowerCommand('off')) {
				projector.power = 'standby'
				projector.lampOn = false
				return 'OK'
			}
			if (parameter === encodePjlinkPowerCommand('on')) {
				projector.power = 'on'
				projector.lampOn = true
				return 'OK'
			}
			return 'ERR2'
		case 'INPT':
			if (parameter === '?') {
				return encodePjlinkInput({
					inputClass: projector.inputClass,
					channel: projector.channel,
				})
			}
			{
				const parsed = parsePjlinkInput(parameter)
				projector.inputClass = parsed.inputClass
				projector.channel = parsed.channel
				return 'OK'
			}
		case 'AVMT':
			if (parameter === '?') {
				return encodePjlinkAvMute(projector.avMute)
			}
			projector.avMute = parsePjlinkAvMute(parameter)
			return 'OK'
		case 'LAMP':
			return `${String(projector.lampHours)} ${projector.lampOn ? '1' : '0'}`
		case 'NAME':
			return projector.name
		case 'INF1':
			return projector.manufacturer
		case 'INF2':
			return projector.model
		case 'INFO':
			return projector.info
		case 'CLSS':
			return projector.pjlinkClass
		case 'ERST':
			return '000000'
		case 'INST':
			return '31 32'
		default: {
			const exhaustive: never = name
			throw new Error(`Unhandled mock PJLink command: ${String(exhaustive)}`)
		}
	}
}

export function createMockPjlinkCommandClient(): PjlinkCommandClient {
	return async ({ host, port, password, command, parameter }) => {
		const projector = requireProjector(host)
		if (!projector.reachable) {
			throw new PjlinkUnreachableError({
				host,
				port,
				message: `connect EHOSTUNREACH ${host}:${String(port)} - mock PJLink projector is offline`,
			})
		}
		if (projector.authRequired && password !== projector.password) {
			throw new Error('PJLink authentication failed (ERRA).')
		}
		const handshake: PjlinkHandshake = projector.authRequired
			? {
					authRequired: true,
					random: 'a1b2c3d4',
					raw: 'PJLINK 1 a1b2c3d4',
				}
			: {
					authRequired: false,
					random: null,
					raw: 'PJLINK 0',
				}
		const value = handleMockCommand(projector, command, parameter)
		if (value === 'ERR2') {
			throw new Error(`PJLink out-of-parameter for ${command}.`)
		}
		return {
			handshake,
			value,
			raw: `%1${command}=${value}`,
		}
	}
}

export function isMockPjlinkHost(host: string, mocksEnabled: boolean) {
	return mocksEnabled && mockProjectors.has(host)
}
