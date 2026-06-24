import { expect, test } from 'vitest'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createKasaAdapter } from './index.ts'
import { type KasaClient } from './types.ts'

function createConfig() {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/connectors/home/default',
		workerWebSocketUrl: 'ws://localhost:3742/connectors/home/default',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
		kasaScanCidrs: ['192.168.1.145/32'],
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
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: true,
	}
}

test('adapter scans, adopts, reads status, and controls adopted Kasa plugs', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	let relayState = 0
	const calls: Array<string> = []
	const fakeClient: KasaClient = {
		async getSysInfo() {
			calls.push('getSysInfo')
			return {
				alias: 'Water recirculating pump',
				model: 'EP25',
				device_id: 'plug-1',
				relay_state: relayState,
			}
		},
		async setRelayState(state) {
			calls.push(state ? 'turnOn' : 'turnOff')
			relayState = state ? 1 : 0
			return {
				system: {
					set_relay_state: {
						err_code: 0,
					},
				},
			}
		},
	}
	const adapter = createKasaAdapter({
		config,
		state,
		storage,
		clientFactory: () => fakeClient,
		scanPlugs: async () => ({
			plugs: [
				{
					plugId: 'plug-1',
					alias: 'Water recirculating pump',
					host: '192.168.1.145',
					port: 80,
					model: 'EP25',
					mac: 'aabbccddeeff',
					deviceId: 'plug-1',
					relayState: 'off',
					rawSysinfo: {
						alias: 'Water recirculating pump',
						model: 'EP25',
						device_id: 'plug-1',
						relay_state: 0,
					},
					rawDiscovery: { server: 'SHIP 2.0' },
					lastSeenAt: '2026-06-24T17:52:00.000Z',
				},
			],
			diagnostics: {
				protocol: 'klap',
				discoveryUrl: '192.168.1.145/32',
				scannedAt: '2026-06-24T17:52:00.000Z',
				udpPorts: [9999, 20002],
				probes: [],
				subnetProbe: {
					cidrs: ['192.168.1.145/32'],
					hostsProbed: 1,
					shipMatches: 1,
					authenticatedMatches: 1,
				},
				credentialStatus: 'present',
			},
		}),
	})

	try {
		expect(adapter.getConfigStatus()).toMatchObject({
			configured: false,
			hasStoredCredentials: false,
		})
		adapter.setCredentials('kent@example.com', 'secret-password')
		expect(adapter.getConfigStatus()).toMatchObject({
			configured: true,
			hasStoredCredentials: true,
			username: 'kent@example.com',
		})

		const scanned = await adapter.scan()
		expect(scanned).toHaveLength(1)
		expect(scanned[0]).toMatchObject({
			plugId: 'plug-1',
			adopted: false,
			relayState: 'off',
		})

		await expect(
			adapter.turnOn({ alias: 'Water recirculating pump' }),
		).rejects.toThrow('not adopted')
		const adopted = adapter.adoptPlug({ alias: 'Water recirculating pump' })
		expect(adopted).toMatchObject({
			plugId: 'plug-1',
			adopted: true,
		})

		expect(await adapter.getPlugStatus({ plugId: 'plug-1' })).toMatchObject({
			relayState: 'off',
		})
		expect(
			await adapter.turnOn({ alias: 'Water recirculating pump' }),
		).toMatchObject({
			requestedRelayState: 'on',
			relayState: 'on',
		})
		expect(await adapter.turnOff({ plugId: 'plug-1' })).toMatchObject({
			requestedRelayState: 'off',
			relayState: 'off',
		})
		expect(calls).toEqual([
			'getSysInfo',
			'turnOn',
			'getSysInfo',
			'turnOff',
			'getSysInfo',
		])
	} finally {
		storage.close()
	}
})

test('adapter marks plugs credential-ready when env credentials are configured', async () => {
	const config = {
		...createConfig(),
		kasaUsername: 'kent@example.com',
		kasaPassword: 'secret-password',
	}
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createKasaAdapter({
		config,
		state,
		storage,
		scanPlugs: async () => ({
			plugs: [
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
			],
			diagnostics: {
				protocol: 'klap',
				discoveryUrl: '192.168.1.145/32',
				scannedAt: '2026-06-24T17:52:00.000Z',
				udpPorts: [9999, 20002],
				probes: [],
				subnetProbe: {
					cidrs: ['192.168.1.145/32'],
					hostsProbed: 1,
					shipMatches: 1,
					authenticatedMatches: 1,
				},
				credentialStatus: 'present',
			},
		}),
	})

	try {
		await adapter.scan()
		expect(adapter.getStatus()).toMatchObject({
			config: {
				configured: true,
				hasEnvCredentials: true,
				hasStoredCredentials: false,
				username: 'kent@example.com',
			},
			plugs: [
				expect.objectContaining({
					hasCredentials: true,
				}),
			],
		})
	} finally {
		storage.close()
	}
})

test('adapter rejects relay control when device reports an error or unchanged state', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	let responseMode: 'err' | 'unchanged' = 'err'
	const fakeClient: KasaClient = {
		async getSysInfo() {
			return {
				alias: 'Water recirculating pump',
				model: 'EP25',
				device_id: 'plug-1',
				relay_state: 0,
			}
		},
		async setRelayState() {
			return {
				system: {
					set_relay_state: {
						err_code: responseMode === 'err' ? -1 : 0,
					},
				},
			}
		},
	}
	const adapter = createKasaAdapter({
		config,
		state,
		storage,
		clientFactory: () => fakeClient,
		scanPlugs: async () => ({
			plugs: [
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
			],
			diagnostics: {
				protocol: 'klap',
				discoveryUrl: '192.168.1.145/32',
				scannedAt: '2026-06-24T17:52:00.000Z',
				udpPorts: [9999, 20002],
				probes: [],
				subnetProbe: {
					cidrs: ['192.168.1.145/32'],
					hostsProbed: 1,
					shipMatches: 1,
					authenticatedMatches: 1,
				},
				credentialStatus: 'present',
			},
		}),
	})

	try {
		adapter.setCredentials('kent@example.com', 'secret-password')
		await adapter.scan()
		adapter.adoptPlug({ plugId: 'plug-1' })

		await expect(adapter.turnOn({ plugId: 'plug-1' })).rejects.toThrow(
			'err_code -1',
		)
		responseMode = 'unchanged'
		await expect(adapter.turnOn({ plugId: 'plug-1' })).rejects.toThrow(
			'did not report relay state on',
		)
	} finally {
		storage.close()
	}
})

test('adapter does not mark stored credentials healthy when fallback auth was used', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const fakeClient: KasaClient = {
		usedConfiguredCredentials: false,
		async getSysInfo() {
			return {
				alias: 'Water recirculating pump',
				model: 'EP25',
				device_id: 'plug-1',
				relay_state: 0,
			}
		},
		async setRelayState() {
			return {
				system: {
					set_relay_state: {
						err_code: 0,
					},
				},
			}
		},
	}
	const adapter = createKasaAdapter({
		config,
		state,
		storage,
		clientFactory: () => fakeClient,
		scanPlugs: async () => ({
			plugs: [
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
			],
			diagnostics: {
				protocol: 'klap',
				discoveryUrl: '192.168.1.145/32',
				scannedAt: '2026-06-24T17:52:00.000Z',
				udpPorts: [9999, 20002],
				probes: [],
				subnetProbe: {
					cidrs: ['192.168.1.145/32'],
					hostsProbed: 1,
					shipMatches: 1,
					authenticatedMatches: 1,
				},
				credentialStatus: 'present',
			},
		}),
	})

	try {
		adapter.setCredentials('kent@example.com', 'bad-password')
		await adapter.scan()
		await adapter.getPlugStatus({ plugId: 'plug-1' })
		expect(adapter.getConfigStatus()).toMatchObject({
			lastAuthenticatedAt: null,
			lastAuthError: null,
		})
	} finally {
		storage.close()
	}
})
