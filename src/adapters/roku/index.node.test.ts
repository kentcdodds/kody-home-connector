import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
	createRokuEcpHandlers,
	resetMockRokuState,
} from '../../../mocks/roku.ts'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { createAppState } from '../../state.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createCourtAdapter } from '../court/index.ts'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import {
	adoptRoku,
	createRokuAdapter,
	getRokuStatus,
	parseRokuMediaPlayerXml,
	scanRokuDevices,
} from './index.ts'
import {
	listRokuDevices,
	persistRokuAdoption,
	upsertDiscoveredRokuDevices,
} from './devices/repository.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.ROKU_DISCOVERY_URL = 'http://roku.mock.local/discovery'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	return loadHomeConnectorConfig()
}

const server = installHomeConnectorMockServer()

beforeEach(() => {
	resetMockRokuState()
})

afterEach(() => {
	server.resetHandlers()
})

test('roku scan populates discovered devices', async () => {
	const config = createConfig()
	const state = createAppState()

	const devices = await scanRokuDevices(state, config)
	const status = getRokuStatus(state)

	expect(devices.length).toBeGreaterThan(0)
	expect(status.discovered.length).toBe(devices.length)
	expect(status.adopted.length).toBe(0)
	expect(status.diagnostics).not.toBeNull()
})

test('scan does not treat discovery adopted flags as connector adoption', async () => {
	const config = createConfig()
	const state = createAppState()

	const devices = await scanRokuDevices(state, config)
	const court = devices.find((device) => /court/i.test(device.name))
	expect(court).toBeTruthy()
	expect(court?.adopted).toBe(false)
	expect(court?.isAdopted).toBe(false)
	expect(devices.every((device) => device.adopted === false)).toBe(true)
	expect(devices.every((device) => device.isAdopted === false)).toBe(true)
})

test('adopting a discovered roku moves it into adopted devices', async () => {
	const config = createConfig()
	const state = createAppState()

	const devices = await scanRokuDevices(state, config)
	const adopted = await adoptRoku(state, devices[0]!.deviceId)
	const status = getRokuStatus(state)

	expect(adopted.adopted).toBe(true)
	expect(adopted.isAdopted).toBe(true)
	expect(
		status.adopted.some((device) => device.deviceId === adopted.deviceId),
	).toBe(true)
})

test('sending a Roku keypress uses the discovered device location', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	await roku.adoptDevice(deviceId)

	const result = await roku.pressKey(deviceId, 'Home')

	expect(result.ok).toBe(true)
	expect(result.deviceId).toBe(deviceId)
	expect(result.key).toBe('Home')
})

test('launching a Roku app succeeds for an adopted device', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	await roku.adoptDevice(deviceId)

	const result = await roku.launchApp(deviceId, '837', {
		contentID: '07RZ_2AyKHQ',
		mediaType: 'live',
	})

	expect(result.ok).toBe(true)
	expect(result.deviceId).toBe(deviceId)
	expect(result.appId).toBe('837')
	expect(result.params).toEqual({
		contentID: '07RZ_2AyKHQ',
		mediaType: 'live',
	})
})

test('listing Roku apps returns structured app metadata', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	await roku.adoptDevice(deviceId)

	const result = await roku.listApps(deviceId)

	expect(result.deviceId).toBe(deviceId)
	expect(result.deviceName).toBe('Living Room Roku')
	expect(result.apps.length).toBeGreaterThan(0)
	expect(result.apps[0]).toMatchObject({
		id: '837',
		name: 'YouTube',
		type: 'appl',
		version: '5.7.0',
	})
})

test('getting the active Roku app returns the current app metadata', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })

	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	await roku.adoptDevice(deviceId)

	const result = await roku.getActiveApp(deviceId)

	expect(result.deviceId).toBe(deviceId)
	expect(result.app).toMatchObject({
		id: '13842',
		name: 'Jellyfin',
	})
})

test('adopted Court Projector Roku survives restart via sqlite hydrate', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-roku-persist-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const config = createTestHomeConnectorConfig({
		dataPath: directory,
		dbPath,
		mocksEnabled: true,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
	})

	try {
		const storage = await createHomeConnectorStorage(config)
		const state = createAppState()
		const roku = createRokuAdapter({ state, config, storage })
		await roku.hydrate()
		const devices = await roku.scan()
		const court = devices.find((device) => device.name === 'Court Projector')
		expect(court).toBeTruthy()
		const adopted = await roku.adoptDevice(court!.deviceId)
		expect(adopted.adopted).toBe(true)
		expect(adopted.isAdopted).toBe(true)
		await storage.close()

		const reopened = await createHomeConnectorStorage(config)
		const freshState = createAppState()
		expect(freshState.devices).toEqual([])
		const hydratedRoku = createRokuAdapter({
			state: freshState,
			config,
			storage: reopened,
		})
		await hydratedRoku.hydrate()
		const status = await hydratedRoku.getStatus()
		const restored = status.adopted.find(
			(device) => device.deviceId === court!.deviceId,
		)
		expect(restored).toMatchObject({
			deviceId: court!.deviceId,
			name: 'Court Projector',
			adopted: true,
			isAdopted: true,
		})

		const courtAdapter = createCourtAdapter({
			config,
			state: freshState,
			globalCache: {
				getStatus() {
					return {
						host: '192.168.1.70',
						port: 4998,
						mocksEnabled: true,
						portMap: [],
						commandCount: 0,
					}
				},
				async sendIr() {
					throw new Error('unused')
				},
			} as never,
			pjlink: {
				async resolveCourtProjector() {
					return null
				},
			} as never,
			roku: hydratedRoku,
			sonos: {
				getStatus() {
					return { allPlayers: [] }
				},
			} as never,
		})
		const courtStatus = await courtAdapter.getStatus()
		expect(courtStatus.rokuDeviceId).toBe(court!.deviceId)
		await reopened.close()
	} finally {
		rmSync(directory, { force: true, recursive: true })
	}
})

test('empty upsertDiscoveredRokuDevices does not prune unadopted devices', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-roku-empty-scan-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const config = createTestHomeConnectorConfig({
		dataPath: directory,
		dbPath,
	})

	try {
		const storage = await createHomeConnectorStorage(config)
		await persistRokuAdoption(storage, config.homeConnectorId, {
			deviceId: 'roku-s0vs348p8ac2',
			id: 'court',
			name: 'Court Projector',
			location: 'http://192.168.1.98:8060/',
			serialNumber: 'S0VS348P8AC2',
			modelName: 'Roku Ultra',
			isAdopted: false,
			lastSeenAt: '2026-09-13T00:00:00.000Z',
			controlEnabled: true,
			adopted: false,
		})
		expect(await listRokuDevices(storage, config.homeConnectorId)).toHaveLength(
			1,
		)

		await upsertDiscoveredRokuDevices(storage, config.homeConnectorId, [])
		const remaining = await listRokuDevices(storage, config.homeConnectorId)
		expect(remaining).toHaveLength(1)
		expect(remaining[0]).toMatchObject({
			deviceId: 'roku-s0vs348p8ac2',
			name: 'Court Projector',
			adopted: false,
		})
		await storage.close()
	} finally {
		rmSync(directory, { force: true, recursive: true })
	}
})

const staleLocation = 'http://192.168.1.98:8060/'
const currentLocation = 'http://192.168.0.120:8060/'

async function withPersistedStaleRoku(
	run: (input: {
		config: ReturnType<typeof createTestHomeConnectorConfig>
		storage: Awaited<ReturnType<typeof createHomeConnectorStorage>>
		roku: ReturnType<typeof createRokuAdapter>
		discoveryRequests: { count: number }
		staleRequests: { count: number }
	}) => Promise<void>,
	options: { discoveredDevices?: Array<Record<string, unknown>> } = {},
) {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-roku-heal-'))
	const config = createTestHomeConnectorConfig({
		dataPath: directory,
		dbPath: path.join(directory, 'home-connector.sqlite'),
		mocksEnabled: true,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
	})
	const discoveryRequests = { count: 0 }
	const staleRequests = { count: 0 }
	server.use(
		http.all(`${staleLocation}*`, () => {
			staleRequests.count++
			return HttpResponse.error()
		}),
		http.get('http://roku.mock.local/discovery', () => {
			discoveryRequests.count++
			return HttpResponse.json({
				devices: options.discoveredDevices ?? [
					{
						id: 'court',
						name: 'Court Projector',
						location: currentLocation,
						serialNumber: 'X02800VP8AC2',
						modelName: 'Roku Ultra',
						controlEnabled: true,
					},
				],
			})
		}),
		...createRokuEcpHandlers(currentLocation),
	)
	const storage = await createHomeConnectorStorage(config)
	try {
		await persistRokuAdoption(storage, config.homeConnectorId, {
			deviceId: 'roku-x02800vp8ac2',
			id: 'court',
			name: 'Court Projector',
			location: staleLocation,
			serialNumber: 'X02800VP8AC2',
			modelName: 'Roku Ultra',
			isAdopted: true,
			lastSeenAt: '2026-09-13T00:00:00.000Z',
			controlEnabled: false,
			adopted: true,
		})
		const roku = createRokuAdapter({
			state: createAppState(),
			config,
			storage,
		})
		await run({ config, storage, roku, discoveryRequests, staleRequests })
	} finally {
		await storage.close()
		rmSync(directory, { force: true, recursive: true })
	}
}

test('stale Roku address heals via rediscovery and retries once', async () => {
	await withPersistedStaleRoku(
		async ({ config, storage, roku, discoveryRequests, staleRequests }) => {
			const result = await roku.launchApp('roku-x02800vp8ac2', '837', {
				contentId: '_mAxik0v1A8',
			})
			expect(result).toMatchObject({
				ok: true,
				deviceId: 'roku-x02800vp8ac2',
				addressHealed: { from: staleLocation, to: currentLocation },
			})
			expect(staleRequests.count).toBe(1)
			expect(discoveryRequests.count).toBe(1)

			const [stored] = await listRokuDevices(storage, config.homeConnectorId)
			expect(stored).toMatchObject({
				deviceId: 'roku-x02800vp8ac2',
				location: currentLocation,
				adopted: true,
				controlEnabled: false,
			})

			const followUp = await roku.getActiveApp('roku-x02800vp8ac2')
			expect(followUp.app?.id).toBe('837')
			expect(followUp.addressHealed).toBeUndefined()
			expect(staleRequests.count).toBe(1)
			expect(discoveryRequests.count).toBe(1)
		},
	)
})

test('stale Roku address throws a clear error when rediscovery does not find it', async () => {
	await withPersistedStaleRoku(
		async ({ config, storage, roku, discoveryRequests, staleRequests }) => {
			await expect(roku.pressKey('roku-x02800vp8ac2', 'Home')).rejects.toThrow(
				/did not respond at its stored address http:\/\/192\.168\.1\.98:8060\/.*Rediscovery was attempted and found Living Room Roku \(roku-other\) at http:\/\/192\.168\.1\.45:8060\/, but not this device/,
			)
			expect(staleRequests.count).toBe(1)
			expect(discoveryRequests.count).toBe(1)
			const stored = await listRokuDevices(storage, config.homeConnectorId)
			expect(
				stored.find((device) => device.deviceId === 'roku-x02800vp8ac2'),
			).toMatchObject({ location: staleLocation, adopted: true })
		},
		{
			discoveredDevices: [
				{
					id: 'other',
					name: 'Living Room Roku',
					location: 'http://192.168.1.45:8060/',
					serialNumber: 'OTHER',
				},
			],
		},
	)
})

test('Roku heal retry failure is reported without a second retry', async () => {
	await withPersistedStaleRoku(async ({ roku, discoveryRequests }) => {
		let retries = 0
		server.use(
			http.all(`${currentLocation}*`, () => {
				retries++
				return HttpResponse.error()
			}),
		)
		await expect(roku.listApps('roku-x02800vp8ac2')).rejects.toThrow(
			/Rediscovery found it at http:\/\/192\.168\.0\.120:8060\/ and the stored address was updated, but the retry also failed/,
		)
		expect(retries).toBe(1)
		expect(discoveryRequests.count).toBe(1)
	})
})

test('Roku HTTP error responses do not trigger rediscovery', async () => {
	await withPersistedStaleRoku(async ({ roku, discoveryRequests }) => {
		server.use(
			http.post(
				`${staleLocation}keypress/:key`,
				() => new HttpResponse(null, { status: 503 }),
			),
		)
		await expect(roku.pressKey('roku-x02800vp8ac2', 'Home')).rejects.toThrow(
			'Roku keypress failed with status 503.',
		)
		expect(discoveryRequests.count).toBe(0)
	})
})

test('roku getMediaPlayer returns player state and the active app', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })
	const devices = await roku.scan()
	const deviceId = devices[0]!.deviceId
	await roku.adoptDevice(deviceId)

	const idle = await roku.getMediaPlayer(deviceId)
	expect(idle).toMatchObject({
		deviceId,
		state: 'close',
		error: false,
		plugin: null,
		positionMs: null,
		activeApp: { id: '13842', name: 'Jellyfin' },
	})

	await roku.launchApp(deviceId, '837', { contentId: 'dQw4w9WgXcQ' })
	const playing = await roku.getMediaPlayer(deviceId)
	expect(playing).toMatchObject({
		state: 'play',
		error: false,
		plugin: { id: '837', name: 'YouTube' },
		positionMs: 12345,
		durationMs: 212000,
		isLive: false,
		activeApp: { id: '837', name: 'YouTube' },
		mediaPlayerError: null,
		activeAppError: null,
	})
})

test('roku getMediaPlayer tolerates a failed media-player query', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })
	const devices = await roku.scan()
	const device = devices[0]!
	await roku.adoptDevice(device.deviceId)
	server.use(
		http.get(
			`${device.location.replace(/\/$/, '')}/query/media-player`,
			() => new HttpResponse(null, { status: 500 }),
		),
	)

	const result = await roku.getMediaPlayer(device.deviceId)
	expect(result).toMatchObject({
		state: null,
		mediaPlayerError: 'Roku media player query failed with status 500.',
		activeApp: { id: '13842' },
	})
})

test('parseRokuMediaPlayerXml tolerates missing fields', () => {
	expect(
		parseRokuMediaPlayerXml('<player state="buffer" error="true"></player>'),
	).toEqual({
		state: 'buffer',
		error: true,
		plugin: null,
		positionMs: null,
		durationMs: null,
		isLive: null,
	})
	expect(
		parseRokuMediaPlayerXml(
			'<player state="play"><plugin id="837" name="YouTube"/><position>500 ms</position><is_live>true</is_live></player>',
		),
	).toMatchObject({
		plugin: { id: '837', name: 'YouTube' },
		positionMs: 500,
		isLive: true,
	})
})

test('roku playYouTube deep links YouTube and verifies playback', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })
	const devices = await roku.scan()
	const device = devices[0]!
	await roku.adoptDevice(device.deviceId)
	const launches: Array<string> = []
	server.use(
		http.post(
			`${device.location.replace(/\/$/, '')}/launch/:appId`,
			({ request }) => {
				launches.push(request.url)
				return undefined
			},
		),
	)

	const result = await roku.playYouTube(device.deviceId, {
		url: 'https://youtu.be/_mAxik0v1A8?is=hhvkIitGxavHyTRe',
	})
	expect(result).toMatchObject({
		launched: true,
		videoId: '_mAxik0v1A8',
		appId: '837',
		mediaType: null,
		verified: true,
		playerState: 'play',
		activeApp: { id: '837' },
		warnings: [],
	})
	expect(launches).toEqual([
		`${device.location.replace(/\/$/, '')}/launch/837?contentId=_mAxik0v1A8`,
	])

	await roku.playYouTube(device.deviceId, {
		url: 'https://www.youtube.com/live/aBcDeFgHiJk',
		mediaType: 'live',
		verify: false,
	})
	expect(launches[1]).toBe(
		`${device.location.replace(/\/$/, '')}/launch/837?contentId=aBcDeFgHiJk&mediaType=live`,
	)
})

test('roku playYouTube returns verified false with the last state instead of throwing', async () => {
	const config = createConfig()
	const state = createAppState()
	const delays: Array<number> = []
	const roku = createRokuAdapter({
		state,
		config,
		delay: async (ms) => {
			delays.push(ms)
		},
	})
	const devices = await roku.scan()
	const device = devices[0]!
	await roku.adoptDevice(device.deviceId)
	const baseUrl = device.location.replace(/\/$/, '')
	server.use(
		http.get(`${baseUrl}/query/apps`, () =>
			HttpResponse.xml(
				'<apps><app id="12" type="appl" version="1">Netflix</app></apps>',
			),
		),
		http.get(`${baseUrl}/query/media-player`, () =>
			HttpResponse.xml('<player error="false" state="close" />'),
		),
	)

	const result = await roku.playYouTube(device.deviceId, {
		url: 'dQw4w9WgXcQ',
	})
	expect(result).toMatchObject({
		launched: true,
		verified: false,
		playerState: 'close',
		activeApp: { id: '837' },
	})
	expect(result.warnings.join('\n')).toMatch(
		/not in this Roku's installed apps/,
	)
	expect(result.warnings.join('\n')).toMatch(/Playback was not confirmed/)
	expect(delays).toEqual(Array.from({ length: 9 }, () => 1000))
})

test('roku playYouTube rejects non-YouTube links before contacting the device', async () => {
	const config = createConfig()
	const state = createAppState()
	const roku = createRokuAdapter({ state, config })
	const devices = await roku.scan()
	await roku.adoptDevice(devices[0]!.deviceId)
	await expect(
		roku.playYouTube(devices[0]!.deviceId, {
			url: 'https://www.youtube.com/playlist?list=PL1234567890',
		}),
	).rejects.toThrow(/playlist link without a video id/)
})
