import { expect, test } from 'vitest'
import { type HomeConnectorConfig } from '../config.ts'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { createHomeConnectorLogger, sanitizeLogValue } from './index.ts'

const silentConsole = {
	debug() {},
	info() {},
	warn() {},
	error() {},
}

function createConfig(): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/connectors/home/default',
		workerWebSocketUrl: 'ws://localhost:3742/connectors/home/default',
		sharedSecret: 'secret',
		islandRouterHost: null,
		islandRouterPort: 22,
		islandRouterUsername: null,
		islandRouterPrivateKeyPath: null,
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8000,
		islandRouterApiBaseUrl: 'https://my.islandrouter.com',
		islandRouterApiRequestTimeoutMs: 8000,
		islandRouterApiAllowInsecureTls: false,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: false,
		accessNetworksUnleashedRequestTimeoutMs: 8000,
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: null,
		venstarScanCidrs: ['192.168.1.10/32'],
		jellyfishScanCidrs: ['192.168.1.10/32'],
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: true,
	}
}

test('sanitizeLogValue redacts secret-shaped keys and inline credentials', () => {
	const sanitized = sanitizeLogValue({
		token: 'abc123',
		headers: {
			Authorization: 'Bearer abc123',
			cookie: 'session=abc123',
		},
		url: 'https://user:pass@example.com/path?token=abc123&room=kitchen',
		message: 'request failed password=abc123 Authorization: Bearer abc123',
	})

	expect(sanitized).toMatchObject({
		token: '[redacted]',
		headers: {
			Authorization: '[redacted]',
			cookie: '[redacted]',
		},
		url: 'https://%5Bredacted%5D:%5Bredacted%5D@example.com/path?token=[redacted]&room=kitchen',
		message: 'request failed password=[redacted] Authorization: [redacted]',
	})
})

test('logger persists sanitized entries and supports filtered reads', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: silentConsole,
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	logger.info('tool.call.finished', 'Finished request token=abc123', {
		toolName: 'bond_list_bridges',
		token: 'abc123',
		url: 'https://example.com?apiKey=abc123',
	})

	const logs = logger.listLogs({
		level: 'info',
		event: 'tool.call.finished',
		query: 'bond_list_bridges',
	})

	expect(logs).toHaveLength(1)
	expect(logs[0]).toMatchObject({
		connectorId: 'default',
		level: 'info',
		event: 'tool.call.finished',
		message: 'Finished request token=[redacted]',
		createdAt: '2026-05-12T18:00:00.000Z',
	})
	expect(logs[0]?.metadata).toMatchObject({
		toolName: 'bond_list_bridges',
		token: '[redacted]',
		url: 'https://example.com/?apiKey=[redacted]',
	})
})

test('logger prunes entries older than eight days', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	storage.db
		.query(
			`
			INSERT INTO home_connector_logs (
				connector_id,
				level,
				event,
				message,
				metadata_json,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?)
		`,
		)
		.run(
			config.homeConnectorId,
			'info',
			'old.event',
			'old',
			'{}',
			'2026-05-01T00:00:00.000Z',
		)
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: silentConsole,
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	expect(logger.listLogs()).toHaveLength(0)
})
