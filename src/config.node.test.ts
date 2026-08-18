import { expect, test } from 'vitest'
import {
	deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces,
	deriveKasaAutoscanCidrsFromInterfaces,
	deriveVenstarAutoscanCidrsFromInterfaces,
	loadHomeConnectorConfig,
} from './config.ts'

const requiredConfigEnv = {
	HOME_CONNECTOR_ID: 'default',
}

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

test('live connector applies discovery defaults when env overrides are absent', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		KODY_USERNAME: undefined,
		MOCKS: 'false',
		ROKU_DISCOVERY_URL: undefined,
		SONOS_DISCOVERY_URL: undefined,
		SAMSUNG_TV_DISCOVERY_URL: undefined,
		BOND_DISCOVERY_URL: undefined,
		LUTRON_DISCOVERY_URL: undefined,
		JELLYFISH_DISCOVERY_URL: undefined,
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		mocksEnabled: false,
		rokuDiscoveryUrl: 'ssdp://239.255.255.250:1900',
		sonosDiscoveryUrl:
			'ssdp://239.255.255.250:1900?st=urn:schemas-upnp-org:device:ZonePlayer:1',
		samsungTvDiscoveryUrl: 'mdns://_samsungmsf._tcp.local',
		bondDiscoveryUrl: 'mdns://_bond._tcp.local',
		lutronDiscoveryUrl: 'mdns://_lutron._tcp.local',
		jellyfishDiscoveryUrl: null,
	})
})

test('explicit discovery URLs override defaults in mock mode', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		MOCKS: 'true',
		ROKU_DISCOVERY_URL: 'http://roku.mock.local/discovery',
		SONOS_DISCOVERY_URL: 'http://sonos.mock.local/discovery',
		SAMSUNG_TV_DISCOVERY_URL: 'http://samsung-tv.mock.local/discovery',
		LUTRON_DISCOVERY_URL: 'http://lutron.mock.local/discovery',
		JELLYFISH_DISCOVERY_URL: 'http://jellyfish.mock.local/discovery',
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		mocksEnabled: true,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
	})
})

test('normalizes HOME_CONNECTOR_ID and defaults the public MCP URL', () => {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_ID: ' Living-Room ',
		HOME_MCP_PUBLIC_BASE_URL: undefined,
		HOME_MCP_OPERATOR_PASSWORD: undefined,
		NODE_ENV: 'test',
	})

	const config = loadHomeConnectorConfig()
	expect(config.homeConnectorId).toBe('living-room')
	expect(config.publicBaseUrl).toBe('https://kody-home.doddsfamily.us')
	expect(config.mcpPath).toBe('/mcp')
	expect(config.mcpUrl).toBe('https://kody-home.doddsfamily.us/mcp')
	expect(config.operatorPassword).toBeNull()
})

test('HOME_MCP_PUBLIC_BASE_URL overrides the published MCP origin', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		HOME_MCP_PUBLIC_BASE_URL: 'https://home.example.test/',
		HOME_MCP_OPERATOR_PASSWORD: 'op-secret',
	})

	const config = loadHomeConnectorConfig()
	expect(config.publicBaseUrl).toBe('https://home.example.test')
	expect(config.mcpUrl).toBe('https://home.example.test/mcp')
	expect(config.operatorPassword).toBe('op-secret')
})

test('production HTTPS public URL requires HOME_MCP_OPERATOR_PASSWORD', () => {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_ID: 'default',
		HOME_MCP_PUBLIC_BASE_URL: 'https://kody-home.doddsfamily.us',
		HOME_MCP_OPERATOR_PASSWORD: undefined,
		NODE_ENV: 'production',
	})

	expect(() => loadHomeConnectorConfig()).toThrow('HOME_MCP_OPERATOR_PASSWORD')
})

test('HOME_CONNECTOR_DATA_KEY is preferred over HOME_CONNECTOR_SHARED_SECRET', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		HOME_CONNECTOR_DATA_KEY: 'data-key',
		HOME_CONNECTOR_SHARED_SECRET: 'legacy-secret',
	})

	const config = loadHomeConnectorConfig()
	expect(config.sharedSecret).toBe('data-key')
})

test('rejects invalid HOME_CONNECTOR_ID values', () => {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_ID: '-bad',
	})
	expect(() => loadHomeConnectorConfig()).toThrow('HOME_CONNECTOR_ID')
})

test('scan CIDR env vars override derived autoscan CIDRs', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		MOCKS: 'false',
		ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.9.0/24, 10.0.0.9/32',
		KASA_SCAN_CIDRS: '192.168.3.0/24, 10.0.0.7/32',
		VENSTAR_SCAN_CIDRS: '192.168.1.0/24, 10.0.0.5/32',
		JELLYFISH_SCAN_CIDRS: '192.168.2.0/24, 10.0.0.6/32',
	})

	const config = loadHomeConnectorConfig()
	expect(config.accessNetworksUnleashedScanCidrs).toEqual([
		'192.168.9.0/24',
		'10.0.0.9/32',
	])
	expect(config.kasaScanCidrs).toEqual(['192.168.3.0/24', '10.0.0.7/32'])
	expect(config.venstarScanCidrs).toEqual(['192.168.1.0/24', '10.0.0.5/32'])
	expect(config.jellyfishScanCidrs).toEqual(['192.168.2.0/24', '10.0.0.6/32'])
})

test('derived Access Networks Unleashed autoscan CIDRs split a /23 into /24 scan blocks', () => {
	expect(
		deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces({
			en0: [
				{
					address: '192.168.6.10',
					netmask: '255.255.254.0',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '192.168.6.10/23',
				},
			],
		}),
	).toEqual(['192.168.6.0/24', '192.168.7.0/24'])
})

test('derived autoscan CIDRs skip container bridge interfaces', () => {
	const warnings: Array<string> = []
	const originalWarn = console.warn
	console.warn = (message?: unknown) => {
		warnings.push(String(message))
	}
	try {
		expect(
			deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces({
				docker0: [
					{
						address: '172.17.0.1',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.17.0.1/16',
					},
				],
				en0: [
					{
						address: '192.168.6.10',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.6.10/24',
					},
				],
			}),
		).toEqual(['192.168.6.0/24'])
	} finally {
		console.warn = originalWarn
	}
	expect(warnings).toEqual([])
})

test('derived Venstar autoscan CIDRs split a /23 into /24 scan blocks', () => {
	expect(
		deriveVenstarAutoscanCidrsFromInterfaces({
			en0: [
				{
					address: '192.168.0.151',
					netmask: '255.255.254.0',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '192.168.0.151/23',
				},
			],
		}),
	).toEqual(['192.168.0.0/24', '192.168.1.0/24'])
})

test('derived Kasa autoscan CIDRs split a /23 into /24 scan blocks', () => {
	expect(
		deriveKasaAutoscanCidrsFromInterfaces({
			en0: [
				{
					address: '192.168.0.151',
					netmask: '255.255.254.0',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '192.168.0.151/23',
				},
			],
		}),
	).toEqual(['192.168.0.0/24', '192.168.1.0/24'])
})

test('derived Venstar autoscan CIDRs collapse narrower private ranges to one /24', () => {
	expect(
		deriveVenstarAutoscanCidrsFromInterfaces({
			en0: [
				{
					address: '192.168.4.18',
					netmask: '255.255.255.128',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '192.168.4.18/25',
				},
			],
		}),
	).toEqual(['192.168.4.0/24'])
})

test('connector data path drives the default db path unless HOME_CONNECTOR_DB_PATH overrides it', () => {
	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			HOME_CONNECTOR_DATA_PATH: '/tmp/kody-home-connector',
			HOME_CONNECTOR_DB_PATH: undefined,
		})

		const config = loadHomeConnectorConfig()
		expect(config.dataPath).toBe('/tmp/kody-home-connector')
		expect(config.dbPath).toBe('/tmp/kody-home-connector/home-connector.sqlite')
	}

	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			HOME_CONNECTOR_DATA_PATH: '/tmp/kody-home-connector',
			HOME_CONNECTOR_DB_PATH: '/tmp/custom-home-connector.sqlite',
		})

		const config = loadHomeConnectorConfig()
		expect(config.dbPath).toBe('/tmp/custom-home-connector.sqlite')
	}
})

test('island router SSH env vars are loaded with defaults', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ISLAND_ROUTER_HOST: 'router.local',
		ISLAND_ROUTER_USERNAME: 'user',
		ISLAND_ROUTER_PRIVATE_KEY_PATH: '/keys/id_ed25519',
		ISLAND_ROUTER_PORT: undefined,
		ISLAND_ROUTER_KNOWN_HOSTS_PATH: '/keys/known_hosts',
		ISLAND_ROUTER_HOST_FINGERPRINT: undefined,
		ISLAND_ROUTER_COMMAND_TIMEOUT_MS: undefined,
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		islandRouterHost: 'router.local',
		islandRouterPort: 22,
		islandRouterUsername: 'user',
		islandRouterPrivateKeyPath: '/keys/id_ed25519',
		islandRouterKnownHostsPath: '/keys/known_hosts',
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8000,
	})
})

test('island router SSH env vars honor explicit port, fingerprint, and timeout', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ISLAND_ROUTER_HOST: '192.168.0.1',
		ISLAND_ROUTER_USERNAME: 'readonly',
		ISLAND_ROUTER_PRIVATE_KEY_PATH: '/keys/id_ed25519',
		ISLAND_ROUTER_PORT: '2222',
		ISLAND_ROUTER_KNOWN_HOSTS_PATH: undefined,
		ISLAND_ROUTER_HOST_FINGERPRINT:
			'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12',
		ISLAND_ROUTER_COMMAND_TIMEOUT_MS: '12000',
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		islandRouterHost: '192.168.0.1',
		islandRouterPort: 2222,
		islandRouterUsername: 'readonly',
		islandRouterPrivateKeyPath: '/keys/id_ed25519',
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint:
			'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12',
		islandRouterCommandTimeoutMs: 12000,
	})
})

test('Access Networks Unleashed TLS and timeout env vars honor safe defaults and explicit overrides', () => {
	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.1.0/24',
			ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: undefined,
			ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS: undefined,
		})

		expect(loadHomeConnectorConfig()).toMatchObject({
			accessNetworksUnleashedScanCidrs: ['192.168.1.0/24'],
			accessNetworksUnleashedAllowInsecureTls: false,
			accessNetworksUnleashedRequestTimeoutMs: 8000,
		})
	}

	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.50.0/24,10.0.0.8/32',
			ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'true',
			ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS: '12000',
		})

		expect(loadHomeConnectorConfig()).toMatchObject({
			accessNetworksUnleashedScanCidrs: ['192.168.50.0/24', '10.0.0.8/32'],
			accessNetworksUnleashedAllowInsecureTls: true,
			accessNetworksUnleashedRequestTimeoutMs: 12000,
		})
	}
})

test('Kasa env vars are loaded with safe defaults and explicit overrides', () => {
	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			KASA_SCAN_CIDRS: '192.168.1.0/24',
			KASA_REQUEST_TIMEOUT_MS: undefined,
			KASA_USERNAME: undefined,
			KASA_PASSWORD: undefined,
		})

		expect(loadHomeConnectorConfig()).toMatchObject({
			kasaScanCidrs: ['192.168.1.0/24'],
			kasaRequestTimeoutMs: 8000,
			kasaUsername: null,
			kasaPassword: null,
		})
	}

	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			KASA_SCAN_CIDRS: '192.168.50.0/24,10.0.0.8/32',
			KASA_REQUEST_TIMEOUT_MS: '12000',
			KASA_USERNAME: ' kent@example.com ',
			KASA_PASSWORD: ' secret ',
		})

		expect(loadHomeConnectorConfig()).toMatchObject({
			kasaScanCidrs: ['192.168.50.0/24', '10.0.0.8/32'],
			kasaRequestTimeoutMs: 12000,
			kasaUsername: 'kent@example.com',
			kasaPassword: 'secret',
		})
	}

	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			KASA_SCAN_CIDRS: '192.168.1.0/24',
			KASA_REQUEST_TIMEOUT_MS: '500',
		})

		expect(loadHomeConnectorConfig().kasaRequestTimeoutMs).toBe(8000)
	}
})

test('Island Router API env vars are loaded with safe defaults and explicit overrides', () => {
	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			ISLAND_ROUTER_API_BASE_URL: undefined,
			ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS: undefined,
			ISLAND_ROUTER_API_ALLOW_INSECURE_TLS: undefined,
		})

		expect(loadHomeConnectorConfig()).toMatchObject({
			islandRouterApiBaseUrl: 'https://my.islandrouter.com',
			islandRouterApiRequestTimeoutMs: 8000,
			islandRouterApiAllowInsecureTls: false,
		})
	}

	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			ISLAND_ROUTER_API_BASE_URL: ' https://router.example.local/// ',
			ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS: '12000',
			ISLAND_ROUTER_API_ALLOW_INSECURE_TLS: 'true',
		})

		expect(loadHomeConnectorConfig()).toMatchObject({
			islandRouterApiBaseUrl: 'https://router.example.local',
			islandRouterApiRequestTimeoutMs: 12000,
			islandRouterApiAllowInsecureTls: true,
		})
	}

	{
		using _env = createTemporaryEnv({
			...requiredConfigEnv,
			ISLAND_ROUTER_API_BASE_URL: undefined,
			ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS: '500',
			ISLAND_ROUTER_API_ALLOW_INSECURE_TLS: undefined,
		})

		expect(loadHomeConnectorConfig().islandRouterApiRequestTimeoutMs).toBe(8000)
	}
})

test('invalid island router port falls back to default 22', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ISLAND_ROUTER_HOST: '192.168.0.1',
		ISLAND_ROUTER_USERNAME: 'readonly',
		ISLAND_ROUTER_PRIVATE_KEY_PATH: '/keys/id_ed25519',
		ISLAND_ROUTER_PORT: '22junk',
	})

	const config = loadHomeConnectorConfig()
	expect(config.islandRouterPort).toBe(22)
})
