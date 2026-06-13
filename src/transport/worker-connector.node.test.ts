import { afterEach, expect, test, vi } from 'vitest'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorLogger } from '../logging/index.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'
import { createAppState } from '../state.ts'

const sentryMock = vi.hoisted(() => ({
	addHomeConnectorSentryBreadcrumb: vi.fn(),
	captureHomeConnectorException: vi.fn(),
	captureHomeConnectorMessage: vi.fn(),
}))

vi.mock('../sentry.ts', () => sentryMock)

const { createWorkerConnector } = await import('./worker-connector.ts')

type FakeWebSocketListener = (event: Record<string, unknown>) => void

class FakeWorkerWebSocket {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly CLOSING = 2
	static readonly CLOSED = 3

	readonly url: string
	readyState = FakeWorkerWebSocket.CONNECTING
	readonly sentMessages: Array<string> = []
	private readonly listeners = new Map<string, Array<FakeWebSocketListener>>()

	constructor(url: string) {
		this.url = url
		fakeWebSocketInstances.push(this)
	}

	addEventListener(type: string, listener: FakeWebSocketListener) {
		const listeners = this.listeners.get(type) ?? []
		listeners.push(listener)
		this.listeners.set(type, listeners)
	}

	send(message: string) {
		this.sentMessages.push(message)
	}

	close() {
		this.dispatchClose({
			code: 1000,
			reason: 'client stop',
			wasClean: true,
		})
	}

	dispatchMessage(data: string) {
		for (const listener of this.listeners.get('message') ?? []) {
			listener({ data })
		}
	}

	dispatchClose(event: { code: number; reason: string; wasClean: boolean }) {
		this.readyState = FakeWorkerWebSocket.CLOSED
		for (const listener of this.listeners.get('close') ?? []) {
			listener(event)
		}
	}
}

const fakeWebSocketInstances: Array<FakeWorkerWebSocket> = []
const originalWebSocket = globalThis.WebSocket

afterEach(() => {
	globalThis.WebSocket = originalWebSocket
	fakeWebSocketInstances.length = 0
	vi.useRealTimers()
})

function createConfig(): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/connectors/home/default',
		workerWebSocketUrl: 'ws://localhost:3742/connectors/home/default',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: false,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
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
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: false,
	}
}

function createLogger(): HomeConnectorLogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		listLogs: vi.fn(() => []),
		pruneExpiredLogs: vi.fn(),
	}
}

function createToolRegistry(): HomeConnectorToolRegistry {
	return {
		list: vi.fn(() => []),
		call: vi.fn(async () => ({
			content: [{ type: 'text', text: 'ok' }],
		})),
	}
}

test('websocket close reporting waits for sustained reconnect failures', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const connector = createWorkerConnector({
		config: createConfig(),
		state: createAppState(),
		logger: createLogger(),
		toolRegistry: createToolRegistry(),
	})

	try {
		await connector.start()
		expect(fakeWebSocketInstances).toHaveLength(1)
		fakeWebSocketInstances[0]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		await vi.advanceTimersByTimeAsync(2_000)

		expect(sentryMock.captureHomeConnectorMessage).not.toHaveBeenCalled()
		expect(fakeWebSocketInstances).toHaveLength(2)
		fakeWebSocketInstances[1]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		await vi.advanceTimersByTimeAsync(4_000)

		expect(sentryMock.captureHomeConnectorMessage).not.toHaveBeenCalled()
		expect(fakeWebSocketInstances).toHaveLength(3)
		fakeWebSocketInstances[2]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})

		expect(sentryMock.captureHomeConnectorMessage).toHaveBeenCalledTimes(1)
		expect(sentryMock.captureHomeConnectorMessage).toHaveBeenCalledWith(
			'Home connector websocket reconnects are failing.',
			expect.objectContaining({
				level: 'error',
				fingerprint: [
					'home-connector',
					'websocket-sustained-reconnect',
					'default',
				],
				tags: {
					home_connector_id: 'default',
					connector_event: 'websocket.sustained_reconnect',
				},
			}),
		)
		expect(sentryMock.addHomeConnectorSentryBreadcrumb).toHaveBeenCalledWith(
			expect.objectContaining({
				category: 'websocket.close',
			}),
		)
	} finally {
		connector.stop()
	}
})

test('websocket shutdown close does not trigger sustained reconnect reporting', async () => {
	vi.useFakeTimers()
	vi.clearAllMocks()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const connector = createWorkerConnector({
		config: createConfig(),
		state: createAppState(),
		logger: createLogger(),
		toolRegistry: createToolRegistry(),
	})

	try {
		await connector.start()
		expect(fakeWebSocketInstances).toHaveLength(1)
		fakeWebSocketInstances[0]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		await vi.advanceTimersByTimeAsync(2_000)
		fakeWebSocketInstances[1]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		await vi.advanceTimersByTimeAsync(4_000)

		expect(fakeWebSocketInstances).toHaveLength(3)
		expect(sentryMock.captureHomeConnectorMessage).not.toHaveBeenCalled()
	} finally {
		connector.stop()
	}

	expect(sentryMock.captureHomeConnectorMessage).not.toHaveBeenCalled()
})

test('websocket ping resets sustained reconnect threshold', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const connector = createWorkerConnector({
		config: createConfig(),
		state: createAppState(),
		logger: createLogger(),
		toolRegistry: createToolRegistry(),
	})

	try {
		await connector.start()
		fakeWebSocketInstances[0]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		await vi.advanceTimersByTimeAsync(2_000)
		fakeWebSocketInstances[1]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		await vi.advanceTimersByTimeAsync(4_000)
		fakeWebSocketInstances[2]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})

		expect(sentryMock.captureHomeConnectorMessage).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(8_000)
		fakeWebSocketInstances[3]?.dispatchMessage(
			JSON.stringify({
				type: 'server.ping',
			}),
		)
		fakeWebSocketInstances[3]?.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})

		expect(sentryMock.captureHomeConnectorMessage).toHaveBeenCalledTimes(1)
	} finally {
		connector.stop()
	}
})
