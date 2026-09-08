import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import { createAppState } from '../../state.ts'
import { createCourtAdapter } from './index.ts'
import { type createGlobalCacheAdapter } from '../global-cache/index.ts'
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
	const selectedAudioInputs: Array<string | undefined> = []
	const selectedTvInputs: Array<string | undefined> = []
	return {
		selectedAudioInputs,
		selectedTvInputs,
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
				selectedAudioInputs.push(playerId)
			},
			async selectTvInput(playerId?: string) {
				selectedTvInputs.push(playerId)
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
	const court = createCourtAdapter({
		config: createTestHomeConnectorConfig(),
		state,
		globalCache: globalCache.adapter,
		roku: roku.adapter,
		sonos: sonos.adapter,
	})

	const result = await court.startRoku()
	expect(globalCache.sent).toEqual(['projector-on', 'hdmi-input-1'])
	expect(sonos.selectedTvInputs).toEqual(['sonos-rincon-804af2a8db1f01400'])
	expect(sonos.selectedAudioInputs).toEqual([])
	expect(roku.keys).toEqual(['Home'])
	expect(result.appId).toBeNull()
	expect(result.sonosInput).toBe('hdmi-tv-spdif')
	expect(result.sonosUri).toBe(
		'x-sonos-htastream:RINCON_804AF2A8DB1F01400:spdif',
	)
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
		roku: createFakeRoku().adapter,
		sonos: createFakeSonos().adapter,
	})
	const green = await court.setRotosphere('green')
	expect(green.reliability).toBe('unreliable-flipper')
	const blackOut = await court.setRotosphere('black-out')
	expect(blackOut.reliability).toBe('proven')
})
