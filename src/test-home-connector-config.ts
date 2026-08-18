import {
	type HomeConnectorConfig,
	defaultHomePublicBaseUrl,
	homeMcpPath,
} from './config.ts'

export function createTestHomeConnectorConfig(
	overrides: Partial<HomeConnectorConfig> = {},
): HomeConnectorConfig {
	const publicBaseUrl = overrides.publicBaseUrl ?? 'http://localhost:4040'
	const mcpPath = overrides.mcpPath ?? homeMcpPath
	const defaults: HomeConnectorConfig = {
		homeConnectorId: 'default',
		publicBaseUrl,
		mcpPath,
		mcpUrl: `${publicBaseUrl}${mcpPath}`,
		operatorPassword: 'operator-password',
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
	return {
		...defaults,
		...overrides,
		publicBaseUrl: overrides.publicBaseUrl ?? defaults.publicBaseUrl,
		mcpPath: overrides.mcpPath ?? defaults.mcpPath,
		mcpUrl:
			overrides.mcpUrl ??
			`${overrides.publicBaseUrl ?? defaults.publicBaseUrl}${overrides.mcpPath ?? defaults.mcpPath}`,
	}
}

export { defaultHomePublicBaseUrl, homeMcpPath }
