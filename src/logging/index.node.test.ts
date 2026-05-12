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

test('logger writes sanitized values to the console sink', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const consoleCalls: Array<Array<unknown>> = []
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: {
			debug() {},
			info() {},
			warn() {},
			error(...args: Array<unknown>) {
				consoleCalls.push(args)
			},
		},
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	logger.error('test.error', 'Failed with token=abc123', {
		error: new Error('password=abc123 Authorization: Bearer abc123'),
		token: 'abc123',
	})

	expect(JSON.stringify(consoleCalls)).not.toContain('abc123')
	expect(consoleCalls[0]).toHaveLength(1)
	expect(JSON.parse(String(consoleCalls[0]?.[0]))).toMatchObject({
		level: 'error',
		event: 'test.error',
		message: 'Failed with token=[redacted]',
		metadata: {
			error: {
				name: 'Error',
				message: 'password=[redacted] Authorization: [redacted]',
			},
			token: '[redacted]',
		},
	})
})

test('logger writes sanitized structured context as one console line', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const consoleCalls: Array<Array<unknown>> = []
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: {
			debug() {},
			info(...args: Array<unknown>) {
				consoleCalls.push(args)
			},
			warn() {},
			error() {},
		},
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	logger.info('worker.websocket.error', 'Home connector websocket error', {
		eventType: 'error',
		readyState: 3,
		url: 'wss://example.com?token=abc123',
		attempt: 2,
	})

	expect(consoleCalls[0]).toHaveLength(1)
	expect(JSON.parse(String(consoleCalls[0]?.[0]))).toMatchObject({
		level: 'info',
		event: 'worker.websocket.error',
		message: 'Home connector websocket error',
		metadata: {
			eventType: 'error',
			readyState: 3,
			url: 'wss://example.com/?token=[redacted]',
			attempt: 2,
		},
	})
})

test('logger still writes entries when retention pruning fails', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const originalQuery = storage.db.query.bind(storage.db)
	storage.db.query = (sql) => {
		if (sql.includes('DELETE FROM home_connector_logs')) {
			throw new Error('delete failed token=abc123')
		}
		return originalQuery(sql)
	}
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: silentConsole,
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	logger.info('test.persisted', 'Persisted after prune failure')

	expect(logger.listLogs({ event: 'test.persisted' })).toHaveLength(1)
})

test('logger sanitizes persistence failure console warnings', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const consoleCalls: Array<Array<unknown>> = []
	const originalQuery = storage.db.query.bind(storage.db)
	storage.db.query = (sql) => {
		if (sql.includes('INSERT INTO home_connector_logs')) {
			throw new Error('insert failed token=abc123')
		}
		return originalQuery(sql)
	}
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: {
			debug() {},
			info() {},
			warn(...args: Array<unknown>) {
				consoleCalls.push(args)
			},
			error() {},
		},
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	logger.info('test.failed_insert', 'Failed insert')

	expect(JSON.stringify(consoleCalls)).not.toContain('abc123')
	expect(consoleCalls.at(-1)).toHaveLength(1)
	expect(JSON.parse(String(consoleCalls.at(-1)?.[0]))).toMatchObject({
		level: 'warn',
		event: 'logger.persist_failed',
		message: 'Failed to persist home connector log entry.',
		metadata: {
			error: {
				name: 'Error',
				message: 'insert failed token=[redacted]',
			},
		},
	})
})

test('logger writes prune failures as one sanitized console line', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const consoleCalls: Array<Array<unknown>> = []
	const originalQuery = storage.db.query.bind(storage.db)
	storage.db.query = (sql) => {
		if (sql.includes('DELETE FROM home_connector_logs')) {
			throw new Error('delete failed token=abc123')
		}
		return originalQuery(sql)
	}

	createHomeConnectorLogger({
		config,
		storage,
		console: {
			debug() {},
			info() {},
			warn(...args: Array<unknown>) {
				consoleCalls.push(args)
			},
			error() {},
		},
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})

	expect(JSON.stringify(consoleCalls)).not.toContain('abc123')
	expect(consoleCalls[0]).toHaveLength(1)
	expect(JSON.parse(String(consoleCalls[0]?.[0]))).toMatchObject({
		level: 'warn',
		event: 'logger.prune_failed',
		message: 'Failed to prune expired home connector log entries.',
		metadata: {
			error: {
				name: 'Error',
				message: 'delete failed token=[redacted]',
			},
		},
	})
})

test('logger excludes expired entries from reads', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	const logger = createHomeConnectorLogger({
		config,
		storage,
		console: silentConsole,
		now: () => new Date('2026-05-12T18:00:00.000Z'),
	})
	const statement = storage.db.query(
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
	statement.run(
		config.homeConnectorId,
		'info',
		'old.event',
		'old',
		'{}',
		'2026-05-01T00:00:00.000Z',
	)
	statement.run(
		config.homeConnectorId,
		'info',
		'new.event',
		'new',
		'{}',
		'2026-05-12T17:00:00.000Z',
	)

	expect(logger.listLogs().map((log) => log.event)).toEqual(['new.event'])
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
