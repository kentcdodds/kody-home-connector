import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { kasaCredentials, kasaPlugs } from '../../storage/schema.ts'
import {
	adoptKasaPlug,
	getKasaCredentials,
	listKasaPlugs,
	listKasaPublicPlugs,
	removeKasaPlug,
	saveKasaCredentials,
	upsertDiscoveredKasaPlugs,
} from './repository.ts'

function createConfig(dbPath: string) {
	return {
		homeConnectorId: 'default',
		publicBaseUrl: 'http://localhost:4040',
		mcpPath: '/mcp',
		mcpUrl: 'http://localhost:4040/mcp',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
		kasaScanCidrs: ['192.168.1.20/32'],
		kasaRequestTimeoutMs: 8_000,
		kasaUsername: null,
		kasaPassword: null,
		islandRouterHost: null,
		islandRouterPort: 22,
		islandRouterUsername: null,
		islandRouterPrivateKeyPath: null,
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8_000,
		islandRouterApiBaseUrl: 'https://my.islandrouter.com',
		islandRouterApiRequestTimeoutMs: 8_000,
		islandRouterApiAllowInsecureTls: false,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		courtPjlinkProjectorId: null,
		pjlinkScanCidrs: ['192.168.0.128/32'],
		pjlinkScanExtraHosts: ['192.168.0.128'],
		pjlinkRequestTimeoutMs: 5_000,
		courtPjlinkTimeoutMs: 1_500,
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
	}
}

test('sqlite storage persists Kasa plugs and encrypted credentials', async () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))

	try {
		await upsertDiscoveredKasaPlugs(storage, 'default', [
			{
				plugId: 'plug-1',
				alias: 'Water recirculating pump',
				host: '192.168.1.145',
				port: 80,
				model: 'EP25',
				mac: 'aabbccddeeff',
				deviceId: 'device-1',
				relayState: 'off',
				rawSysinfo: {
					alias: 'Water recirculating pump',
					model: 'EP25',
					relay_state: 0,
				},
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:52:00.000Z',
			},
		])
		await adoptKasaPlug(storage, 'default', 'plug-1')
		await saveKasaCredentials({
			storage,
			connectorId: 'default',
			username: 'kent@example.com',
			password: 'kasa-password',
			lastAuthenticatedAt: '2026-06-24T17:53:00.000Z',
		})

		expect(await getKasaCredentials(storage, 'default')).toMatchObject({
			username: 'kent@example.com',
			password: 'kasa-password',
			lastAuthenticatedAt: '2026-06-24T17:53:00.000Z',
		})
		expect(await listKasaPublicPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'plug-1',
				alias: 'Water recirculating pump',
				adopted: true,
				hasCredentials: true,
				relayState: 'off',
			}),
		])

		const rawPasswordRow = await storage.db.find(kasaCredentials, {
			connector_id: 'default',
		})
		expect(rawPasswordRow?.username).toMatch(/^enc:v1:/)
		expect(rawPasswordRow?.username).not.toContain('kent@example.com')
		expect(rawPasswordRow?.password).toMatch(/^enc:v1:/)
		expect(rawPasswordRow?.password).not.toContain('kasa-password')

		await storage.db.update(
			kasaPlugs,
			{ connector_id: 'default', plug_id: 'plug-1' },
			{
				raw_sysinfo_json: 'not-json',
				raw_discovery_json: 'also-not-json',
				relay_state: 'nonsense',
			},
		)
		expect(await listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				rawSysinfo: null,
				rawDiscovery: null,
				relayState: 'unknown',
			}),
		])
		await storage.db.update(
			kasaPlugs,
			{ connector_id: 'default', plug_id: 'plug-1' },
			{ raw_sysinfo_json: '[]', raw_discovery_json: '"scalar"' },
		)
		expect(await listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				rawSysinfo: null,
				rawDiscovery: null,
			}),
		])

		await removeKasaPlug({
			storage,
			connectorId: 'default',
			plugId: 'plug-1',
		})
		expect(await listKasaPlugs(storage, 'default')).toEqual([])
	} finally {
		await storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('upsert migrates adopted host fallback rows to stable plug ids', async () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))

	try {
		await upsertDiscoveredKasaPlugs(storage, 'default', [
			{
				plugId: 'host:192.168.1.145',
				alias: 'Kasa plug 192.168.1.145',
				host: '192.168.1.145',
				port: 80,
				model: null,
				mac: null,
				deviceId: null,
				relayState: 'unknown',
				rawSysinfo: null,
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:52:00.000Z',
			},
		])
		await adoptKasaPlug(storage, 'default', 'host:192.168.1.145')

		await upsertDiscoveredKasaPlugs(storage, 'default', [
			{
				plugId: 'stable-device-id',
				alias: 'Water recirculating pump',
				host: '192.168.1.145',
				port: 80,
				model: 'EP25',
				mac: 'aabbccddeeff',
				deviceId: 'stable-device-id',
				relayState: 'off',
				rawSysinfo: {
					alias: 'Water recirculating pump',
					device_id: 'stable-device-id',
					relay_state: 0,
				},
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:53:00.000Z',
			},
		])

		expect(await listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'stable-device-id',
				adopted: true,
				alias: 'Water recirculating pump',
			}),
		])
	} finally {
		await storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('upsert promotes existing stable plug adoption from host fallback rows', async () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))

	try {
		await upsertDiscoveredKasaPlugs(storage, 'default', [
			{
				plugId: 'stable-device-id',
				alias: 'Water recirculating pump',
				host: '192.168.1.145',
				port: 80,
				model: 'EP25',
				mac: 'aabbccddeeff',
				deviceId: 'stable-device-id',
				relayState: 'off',
				rawSysinfo: null,
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:52:00.000Z',
			},
			{
				plugId: 'host:192.168.1.145',
				alias: 'Kasa plug 192.168.1.145',
				host: '192.168.1.145',
				port: 80,
				model: null,
				mac: null,
				deviceId: null,
				relayState: 'unknown',
				rawSysinfo: null,
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:52:30.000Z',
			},
		])
		await adoptKasaPlug(storage, 'default', 'host:192.168.1.145')

		await upsertDiscoveredKasaPlugs(storage, 'default', [
			{
				plugId: 'stable-device-id',
				alias: 'Water recirculating pump',
				host: '192.168.1.145',
				port: 80,
				model: 'EP25',
				mac: 'aabbccddeeff',
				deviceId: 'stable-device-id',
				relayState: 'on',
				rawSysinfo: {
					alias: 'Water recirculating pump',
					device_id: 'stable-device-id',
					relay_state: 1,
				},
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:53:00.000Z',
			},
		])

		expect(await listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'stable-device-id',
				adopted: true,
				relayState: 'on',
			}),
		])
	} finally {
		await storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('empty Kasa scan does not prune existing unadopted plugs', async () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))

	try {
		await upsertDiscoveredKasaPlugs(storage, 'default', [
			{
				plugId: 'plug-1',
				alias: 'Water recirculating pump',
				host: '192.168.1.145',
				port: 80,
				model: 'EP25',
				mac: 'aabbccddeeff',
				deviceId: 'plug-1',
				relayState: 'off',
				rawSysinfo: null,
				rawDiscovery: { server: 'SHIP 2.0' },
				lastSeenAt: '2026-06-24T17:52:00.000Z',
			},
		])

		await upsertDiscoveredKasaPlugs(storage, 'default', [])

		expect(await listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'plug-1',
				adopted: false,
			}),
		])
	} finally {
		await storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})
