import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
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

installHomeConnectorMockServer()

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
