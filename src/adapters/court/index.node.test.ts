import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import { createAppState } from '../../state.ts'
import { createCourtAdapter } from './index.ts'
import { type createGlobalCacheAdapter } from '../global-cache/index.ts'
import {
	PjlinkProtocolError,
	PjlinkUnreachableError,
	type createPjlinkAdapter,
} from '../pjlink/index.ts'
import { type createRokuAdapter } from '../roku/index.ts'
import { type createSonosAdapter } from '../sonos/index.ts'
import { type RokuDeviceRecord } from '../roku/types.ts'

const courtRoku: RokuDeviceRecord = {
	deviceId: 'roku-court-projector',
	id: 'court',
	name: 'Court Projector',
	location: 'http://192.168.1.98:8060/',
	serialNumber: 'S0VS348P8AC2',
	modelName: 'Roku Ultra',
	isAdopted: true,
	lastSeenAt: '2026-09-07T00:00:00.000Z',
	controlEnabled: true,
	adopted: true,
}

function createFakeGlobalCache() {
	const sent: Array<string> = []
	return {
		sent,
		adapter: {
			getStatus() {
				return {
					host: '192.168.1.70',
					port: 4998,
					mocksEnabled: true,
					portMap: [],
					commandCount: 0,
				}
			},
			async sendIr(commandId: string) {
				sent.push(commandId)
				return {
					commandId,
					connector: '1:1',
					response: `completeir,1:1,1`,
					setIrResponse: null,
				}
			},
		} as unknown as ReturnType<typeof createGlobalCacheAdapter>,
	}
}

function createFakePjlink(
	input: {
		unreachable?: boolean
		unavailableTime?: boolean
		getPowerState?: 'standby' | 'on' | 'cooling' | 'warming'
		projector?: { projectorId: string; name: string; host: string } | null
	} = {},
) {
	const commands: Array<string> = []
	const powerQueries: Array<string> = []
	const timeouts: Array<number | undefined> = []
	const projector =
		input.projector === undefined
			? {
					projectorId: 'pjlink-005041b2fd09',
					name: 'Court Optoma ZK810TST',
					host: '192.168.0.128',
					adopted: true,
				}
			: input.projector
	return {
		commands,
		powerQueries,
		timeouts,
		adapter: {
			async resolveCourtProjector() {
				return projector
			},
			async setPower(
				_selector: { projectorId?: string },
				command: 'on' | 'off',
				options: { timeoutMs?: number } = {},
			) {
				timeouts.push(options.timeoutMs)
				if (input.unreachable) {
					throw new PjlinkUnreachableError({
						host: '192.168.0.128',
						port: 4352,
						message: 'connect EHOSTUNREACH 192.168.0.128:4352',
					})
				}
				if (input.unavailableTime) {
					throw new PjlinkProtocolError({
						code: 'ERR3',
						message:
							'PJLink unavailable time for POWR (projector is busy or cooling).',
						raw: '%1POWR=ERR3',
					})
				}
				commands.push(command)
				return {
					projector,
					power: command === 'on' ? 'on' : 'standby',
					command,
					raw: `%1POWR=OK`,
				}
			},
			async getPower(
				_selector: { projectorId?: string } = {},
				options: { timeoutMs?: number } = {},
			) {
				timeouts.push(options.timeoutMs)
				powerQueries.push('query')
				const power = input.getPowerState ?? 'on'
				return {
					projector,
					power,
					command: 'query' as const,
					raw: `%1POWR=${power === 'on' ? '1' : power === 'standby' ? '0' : power === 'cooling' ? '2' : '3'}`,
				}
			},
		} as unknown as ReturnType<typeof createPjlinkAdapter>,
	}
}

function createFakeRoku() {
	const keys: Array<string> = []
	const launches: Array<string> = []
	return {
		keys,
		launches,
		adapter: {
			async pressKey(_deviceId: string, key: string) {
				keys.push(key)
				return { ok: true, key }
			},
			async launchApp(_deviceId: string, appId: string) {
				launches.push(appId)
				return { ok: true, appId }
			},
			async listApps() {
				return {
					deviceId: courtRoku.deviceId,
					deviceName: courtRoku.name,
					apps: [
						{
							id: '837',
							name: 'YouTube',
							type: 'appl',
							version: '1',
						},
					],
					responseText: '',
				}
			},
		} as unknown as ReturnType<typeof createRokuAdapter>,
	}
}

function createFakeSonos() {
	const selectedLineIn: Array<string | undefined> = []
	const selectedTv: Array<string | undefined> = []
	return {
		selectedLineIn,
		selectedTv,
		adapter: {
			getStatus() {
				return {
					allPlayers: [
						{
							playerId: 'sonos-rincon-804af2a8db1f01400',
							roomName: 'Sport Court',
							friendlyName: 'Sport Court Sonos Amp',
							displayName: 'Amp',
						},
					],
				}
			},
			async selectAudioInput(playerId?: string) {
				selectedLineIn.push(playerId)
			},
			async selectTvInput(playerId?: string) {
				selectedTv.push(playerId)
				return {
					playerId: playerId ?? 'sonos-rincon-804af2a8db1f01400',
					uri: 'x-sonos-htastream:RINCON_804AF2A8DB1F01400:spdif',
				}
			},
		} as unknown as ReturnType<typeof createSonosAdapter>,
	}
}

test('startRoku powers the projector, selects HDMI 1, routes Sonos, and opens Home', async () => {
	const state = createAppState()
	state.devices = [courtRoku]
	const globalCache = createFakeGlobalCache()
	const roku = createFakeRoku()
	const sonos = createFakeSonos()
	const pjlink = createFakePjlink()
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: pjlink.adapter,
		roku: roku.adapter,
		sonos: sonos.adapter,
	})

	const result = await court.startRoku()
	expect(pjlink.commands).toEqual(['on'])
	expect(globalCache.sent).toEqual(['hdmi-input-1'])
	expect(sonos.selectedTv).toEqual(['sonos-rincon-804af2a8db1f01400'])
	expect(sonos.selectedLineIn).toEqual([])
	expect(result.sonosInput).toBe('tv')
	expect(result.sonosInputUri).toBe(
		'x-sonos-htastream:RINCON_804AF2A8DB1F01400:spdif',
	)
	expect(roku.keys).toEqual(['Home'])
	expect(result.appId).toBeNull()
})

test('startRoku continues when POWR returns unavailable-time but lamp is already on', async () => {
	const state = createAppState()
	state.devices = [courtRoku]
	const globalCache = createFakeGlobalCache()
	const roku = createFakeRoku()
	const sonos = createFakeSonos()
	const pjlink = createFakePjlink({
		unavailableTime: true,
		getPowerState: 'on',
	})
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: pjlink.adapter,
		roku: roku.adapter,
		sonos: sonos.adapter,
	})

	const result = await court.startRoku()
	expect(pjlink.commands).toEqual([])
	expect(pjlink.powerQueries).toEqual(['query'])
	expect(globalCache.sent).toEqual(['hdmi-input-1'])
	expect(sonos.selectedTv).toEqual(['sonos-rincon-804af2a8db1f01400'])
	expect(roku.keys).toEqual(['Home'])
	expect(result.projector).toMatchObject({
		transport: 'pjlink',
		irFallback: false,
		alreadyPowered: true,
		observedPower: 'on',
	})
})

test('startRoku can launch a Roku app by name', async () => {
	const state = createAppState()
	state.devices = [courtRoku]
	const globalCache = createFakeGlobalCache()
	const roku = createFakeRoku()
	const sonos = createFakeSonos()
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: createFakePjlink().adapter,
		roku: roku.adapter,
		sonos: sonos.adapter,
	})

	const result = await court.startRoku({ appName: 'YouTube' })
	expect(roku.launches).toEqual(['837'])
	expect(result.appId).toBe('837')
})

test('Rotosphere green is marked unreliable except proven colors', async () => {
	const state = createAppState()
	const globalCache = createFakeGlobalCache()
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: createFakePjlink().adapter,
		roku: createFakeRoku().adapter,
		sonos: createFakeSonos().adapter,
	})
	const green = await court.setRotosphere('green')
	expect(green.reliability).toBe('unreliable-flipper')
	const blackOut = await court.setRotosphere('black-out')
	expect(blackOut.reliability).toBe('proven')
})

test('projectorOn falls back to iTach IR when PJLink is unreachable', async () => {
	const state = createAppState()
	const globalCache = createFakeGlobalCache()
	const pjlink = createFakePjlink({ unreachable: true })
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: pjlink.adapter,
		roku: createFakeRoku().adapter,
		sonos: createFakeSonos().adapter,
	})

	const result = await court.projectorOn()
	expect(result.transport).toBe('itach-ir')
	expect(result.irFallback).toBe(true)
	expect(result.fallbackReason).toBe('pjlink-unreachable')
	expect(pjlink.timeouts).toEqual([1_500])
	expect(globalCache.sent).toEqual(['projector-on'])
})

test('projectorStandby uses PJLink when the court projector is adopted', async () => {
	const state = createAppState()
	const globalCache = createFakeGlobalCache()
	const pjlink = createFakePjlink()
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: pjlink.adapter,
		roku: createFakeRoku().adapter,
		sonos: createFakeSonos().adapter,
	})

	const result = await court.projectorStandby()
	expect(result.transport).toBe('pjlink')
	expect(pjlink.commands).toEqual(['off'])
	expect(pjlink.timeouts).toEqual([1_500])
	expect(globalCache.sent).toEqual([])
})

test('projectorOn uses iTach IR immediately when no court projector is adopted', async () => {
	const state = createAppState()
	const globalCache = createFakeGlobalCache()
	const pjlink = createFakePjlink({ projector: null })
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: pjlink.adapter,
		roku: createFakeRoku().adapter,
		sonos: createFakeSonos().adapter,
	})

	const result = await court.projectorOn()
	expect(result.transport).toBe('itach-ir')
	expect(result.irFallback).toBe(true)
	expect(result.fallbackReason).toBe('pjlink-not-configured')
	expect(pjlink.commands).toEqual([])
	expect(globalCache.sent).toEqual(['projector-on'])
})

test('getStatus documents Roku hard-off and LAN-dark caveats', async () => {
	const state = createAppState()
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: createFakeGlobalCache().adapter,
		pjlink: createFakePjlink().adapter,
		roku: createFakeRoku().adapter,
		sonos: createFakeSonos().adapter,
	})
	const status = await court.getStatus()
	expect(status.rokuPower.reliableHardOff).toBe(false)
	expect(status.projector.lanDarkAfterFullOff).toBe(true)
	expect(status.projector.courtPjlinkTimeoutMs).toBe(1_500)
	expect(status.projector.preferredTransport).toBe('pjlink')
	expect(status.bluray.connected).toBe(false)
	expect(status.bluray.host).toBeNull()
})

test('startBluray selects HDMI 2 and still returns when the player is offline', async () => {
	const state = createAppState()
	const globalCache = createFakeGlobalCache()
	const sonos = createFakeSonos()
	const pjlink = createFakePjlink()
	const blurayCalls: Array<string> = []
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		pjlink: pjlink.adapter,
		roku: createFakeRoku().adapter,
		sonos: sonos.adapter,
		bluray: {
			async getStatus() {
				return {
					connected: false,
					reason: 'not configured',
					host: null,
				}
			},
			async powerOn() {
				blurayCalls.push('powerOn')
				return {
					connected: false,
					reason: 'Sony IRCC endpoints did not respond',
					command: 'powerOn',
				}
			},
		} as never,
	})

	const result = await court.startBluray()
	expect(pjlink.commands).toEqual(['on'])
	expect(globalCache.sent).toEqual(['hdmi-input-2'])
	expect(sonos.selectedTv).toEqual(['sonos-rincon-804af2a8db1f01400'])
	expect(blurayCalls).toEqual(['powerOn'])
	expect(result.bluray).toMatchObject({ connected: false })
	expect(result.notes).toMatch(/HDMI 2/)
})
