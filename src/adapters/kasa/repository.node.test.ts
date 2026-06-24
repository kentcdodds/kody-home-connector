import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
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
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/connectors/home/default',
		workerWebSocketUrl: 'ws://localhost:3742/connectors/home/default',
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
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
	}
}

test('sqlite storage persists Kasa plugs and encrypted credentials', () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredKasaPlugs(storage, 'default', [
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
		adoptKasaPlug(storage, 'default', 'plug-1')
		saveKasaCredentials({
			storage,
			connectorId: 'default',
			username: 'kent@example.com',
			password: 'kasa-password',
			lastAuthenticatedAt: '2026-06-24T17:53:00.000Z',
		})

		expect(getKasaCredentials(storage, 'default')).toMatchObject({
			username: 'kent@example.com',
			password: 'kasa-password',
			lastAuthenticatedAt: '2026-06-24T17:53:00.000Z',
		})
		expect(listKasaPublicPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'plug-1',
				alias: 'Water recirculating pump',
				adopted: true,
				hasCredentials: true,
				relayState: 'off',
			}),
		])

		const rawPasswordRow = storage.db
			.query(
				`
					SELECT username, password
					FROM kasa_credentials
					WHERE connector_id = ?
				`,
			)
			.get('default') as { username: string; password: string } | undefined
		expect(rawPasswordRow?.username).toMatch(/^enc:v1:/)
		expect(rawPasswordRow?.username).not.toContain('kent@example.com')
		expect(rawPasswordRow?.password).toMatch(/^enc:v1:/)
		expect(rawPasswordRow?.password).not.toContain('kasa-password')

		storage.db
			.query(
				`
					UPDATE kasa_plugs
					SET raw_sysinfo_json = ?, raw_discovery_json = ?, relay_state = ?
					WHERE connector_id = ? AND plug_id = ?
				`,
			)
			.run('not-json', 'also-not-json', 'nonsense', 'default', 'plug-1')
		expect(listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				rawSysinfo: null,
				rawDiscovery: null,
				relayState: 'unknown',
			}),
		])
		storage.db
			.query(
				`
					UPDATE kasa_plugs
					SET raw_sysinfo_json = ?, raw_discovery_json = ?
					WHERE connector_id = ? AND plug_id = ?
				`,
			)
			.run('[]', '"scalar"', 'default', 'plug-1')
		expect(listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				rawSysinfo: null,
				rawDiscovery: null,
			}),
		])

		removeKasaPlug({
			storage,
			connectorId: 'default',
			plugId: 'plug-1',
		})
		expect(listKasaPlugs(storage, 'default')).toEqual([])
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('upsert migrates adopted host fallback rows to stable plug ids', () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredKasaPlugs(storage, 'default', [
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
		adoptKasaPlug(storage, 'default', 'host:192.168.1.145')

		upsertDiscoveredKasaPlugs(storage, 'default', [
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

		expect(listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'stable-device-id',
				adopted: true,
				alias: 'Water recirculating pump',
			}),
		])
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('empty Kasa scan does not prune existing unadopted plugs', () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-kasa-'),
	)
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredKasaPlugs(storage, 'default', [
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

		upsertDiscoveredKasaPlugs(storage, 'default', [])

		expect(listKasaPlugs(storage, 'default')).toEqual([
			expect.objectContaining({
				plugId: 'plug-1',
				adopted: false,
			}),
		])
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})
