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

type FakeWebSocketListener = (
	event: Record<string, unknown>,
) => void | Promise<void>

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

	close(code = 1000, reason = 'client stop') {
		this.dispatchClose({
			code,
			reason,
			wasClean: code === 1000,
		})
	}

	async dispatchOpen() {
		this.readyState = FakeWorkerWebSocket.OPEN
		await Promise.all(
			(this.listeners.get('open') ?? []).map((listener) => listener({})),
		)
	}

	async dispatchMessage(data: string) {
		for (const listener of this.listeners.get('message') ?? []) {
			await listener({ data })
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
	vi.clearAllMocks()
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

function createRegisteredToolRegistry(
	tools: HomeConnectorToolRegistry['list'],
): HomeConnectorToolRegistry {
	return {
		list: vi.fn(tools),
		call: vi.fn(async () => ({
			content: [{ type: 'text', text: 'ok' }],
		})),
	}
}

function getSentMessage(socket: FakeWorkerWebSocket, index: number) {
	const raw = socket.sentMessages[index]
	if (!raw) return null
	return JSON.parse(raw) as Record<string, unknown>
}

function countToolsChangedNotifications(socket: FakeWorkerWebSocket) {
	return socket.sentMessages
		.map((message) => JSON.parse(message) as Record<string, unknown>)
		.filter((message) => {
			const jsonRpcMessage = message['message'] as
				| Record<string, unknown>
				| undefined
			return jsonRpcMessage?.['method'] === 'notifications/tools/list_changed'
		}).length
}

const bondShadeTool = {
	name: 'bond_shade_set_position',
	title: 'Set Bond Shade Position',
	description: 'Set a Bond shade position.',
	inputSchema: {},
} satisfies ReturnType<HomeConnectorToolRegistry['list']>[number]

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

test('acknowledged websocket registers non-empty tool inventory when Kody lists tools', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger: createLogger(),
		toolRegistry: createRegisteredToolRegistry(() => [bondShadeTool]),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)

		expect(getSentMessage(socket, 0)).toMatchObject({
			type: 'connector.hello',
		})
		expect(getSentMessage(socket, 1)).toMatchObject({
			type: 'connector.jsonrpc',
			message: {
				method: 'notifications/tools/list_changed',
			},
		})
		expect(state.connection.connected).toBe(true)
		expect(state.connection.localToolCount).toBe(1)
		expect(state.connection.toolInventoryStatus).toBe('refresh_requested')

		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
				},
			}),
		)

		expect(getSentMessage(socket, 2)).toMatchObject({
			type: 'connector.jsonrpc',
			message: {
				id: 1,
				result: {
					tools: [bondShadeTool],
				},
			},
		})
		expect(state.connection.toolInventoryStatus).toBe('registered')
		expect(state.connection.lastToolsListRequestAt).not.toBeNull()

		await vi.advanceTimersByTimeAsync(5_000)

		expect(socket.sentMessages).toHaveLength(3)
	} finally {
		connector.stop()
	}
})

test('ack preserves tool inventory when Kody lists tools before ack', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger: createLogger(),
		toolRegistry: createRegisteredToolRegistry(() => [bondShadeTool]),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'pre-ack-tools',
					method: 'tools/list',
				},
			}),
		)

		expect(state.connection.toolInventoryStatus).toBe('registered')
		expect(getSentMessage(socket, 1)).toMatchObject({
			type: 'connector.jsonrpc',
			message: {
				id: 'pre-ack-tools',
				result: {
					tools: [bondShadeTool],
				},
			},
		})

		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)
		await vi.advanceTimersByTimeAsync(5_000)

		expect(state.connection.connected).toBe(true)
		expect(state.connection.toolInventoryStatus).toBe('registered')
		expect(state.connection.toolInventoryStatusReason).toContain('before ack')
		expect(countToolsChangedNotifications(socket)).toBe(0)
		expect(socket.sentMessages).toHaveLength(2)
	} finally {
		connector.stop()
	}
})

test('in-flight JSON-RPC responses are dropped when websocket closes', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const logger = createLogger()
	const deferred =
		Promise.withResolvers<
			Awaited<ReturnType<HomeConnectorToolRegistry['call']>>
		>()
	const toolRegistry: HomeConnectorToolRegistry = {
		list: vi.fn(() => []),
		call: vi.fn(() => deferred.promise),
	}
	const connector = createWorkerConnector({
		config: createConfig(),
		state: createAppState(),
		logger,
		toolRegistry,
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		const messagePromise = socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'in-flight-tool',
					method: 'tools/call',
					params: {
						name: 'bond_get_bridge_version',
						arguments: { bridgeId: 'bond-bridge' },
					},
				},
			}),
		)

		socket.dispatchClose({
			code: 1006,
			reason: '',
			wasClean: false,
		})
		deferred.resolve({
			content: [{ type: 'text', text: 'ok' }],
		})
		await messagePromise

		expect(socket.sentMessages).toHaveLength(1)
		expect(getSentMessage(socket, 0)).toMatchObject({
			type: 'connector.hello',
		})
		expect(logger.warn).toHaveBeenCalledWith(
			'worker.websocket.response_dropped',
			expect.stringContaining('skipped sending JSON-RPC response'),
			expect.objectContaining({
				requestId: 'in-flight-tool',
				method: 'tools/call',
				hasActiveSocket: false,
			}),
		)
		expect(sentryMock.captureHomeConnectorException).not.toHaveBeenCalled()
	} finally {
		connector.stop()
	}
})

test('connected websocket warns without reconnecting when Kody never lists tools', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const logger = createLogger()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger,
		toolRegistry: createRegisteredToolRegistry(() => [bondShadeTool]),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)

		expect(countToolsChangedNotifications(socket)).toBe(1)

		await vi.advanceTimersByTimeAsync(5_000)
		expect(countToolsChangedNotifications(socket)).toBe(2)
		expect(logger.warn).toHaveBeenCalledWith(
			'worker.tools.remote_list_missing',
			expect.stringContaining('Kody has not requested'),
			expect.objectContaining({
				localToolCount: 1,
				attempt: 1,
			}),
		)

		await vi.advanceTimersByTimeAsync(5_000)
		expect(countToolsChangedNotifications(socket)).toBe(3)

		await vi.advanceTimersByTimeAsync(5_000)
		expect(logger.warn).toHaveBeenCalledWith(
			'worker.tools.remote_list_still_missing',
			expect.stringContaining(
				'Home connector tool inventory registration is still pending',
			),
			expect.objectContaining({
				localToolCount: 1,
				attempts: 3,
			}),
		)
		expect(sentryMock.captureHomeConnectorMessage).not.toHaveBeenCalled()
		expect(state.connection.connected).toBe(true)
		expect(state.connection.toolInventoryStatus).toBe('remote_list_missing')
		expect(state.connection.toolInventoryStatusReason).toContain(
			'Kody did not request tools/list',
		)
		expect(state.connection.toolInventoryRecoveryCount).toBe(0)

		await vi.advanceTimersByTimeAsync(2_000)
		expect(fakeWebSocketInstances).toHaveLength(1)
	} finally {
		connector.stop()
	}
})

test('connected websocket recovers when local registry is initially empty', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	let tools: ReturnType<HomeConnectorToolRegistry['list']> = []
	const state = createAppState()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger: createLogger(),
		toolRegistry: createRegisteredToolRegistry(() => tools),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)

		expect(state.connection.toolInventoryStatus).toBe('empty_local_registry')
		expect(state.connection.localToolCount).toBe(0)

		tools = [bondShadeTool]
		await vi.advanceTimersByTimeAsync(5_000)

		expect(state.connection.toolInventoryStatus).toBe('refresh_requested')
		expect(state.connection.localToolCount).toBe(1)
		expect(getSentMessage(socket, 2)).toMatchObject({
			type: 'connector.jsonrpc',
			message: {
				method: 'notifications/tools/list_changed',
			},
		})

		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'tools',
					method: 'tools/list',
				},
			}),
		)

		expect(state.connection.toolInventoryStatus).toBe('registered')
		expect(getSentMessage(socket, 3)).toMatchObject({
			type: 'connector.jsonrpc',
			message: {
				id: 'tools',
				result: {
					tools: [bondShadeTool],
				},
			},
		})
	} finally {
		connector.stop()
	}
})

test('connected websocket keeps empty local registry status after Kody lists zero tools', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const logger = createLogger()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger,
		toolRegistry: createRegisteredToolRegistry(() => []),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'empty-tools',
					method: 'tools/list',
				},
			}),
		)

		expect(state.connection.toolInventoryStatus).toBe('empty_local_registry')
		expect(getSentMessage(socket, 2)).toMatchObject({
			type: 'connector.jsonrpc',
			message: {
				id: 'empty-tools',
				result: {
					tools: [],
				},
			},
		})

		await vi.advanceTimersByTimeAsync(15_000)

		expect(fakeWebSocketInstances).toHaveLength(1)
		expect(state.connection.connected).toBe(true)
		expect(state.connection.toolInventoryStatus).toBe('empty_local_registry')
		expect(state.connection.toolInventoryStatusReason).toContain(
			'stayed empty after retries',
		)
		expect(state.connection.toolInventoryRecoveryCount).toBe(0)
		expect(logger.error).toHaveBeenCalledWith(
			'worker.tools.empty_registry_persistent',
			'Home connector local tool registry stayed empty after retries.',
			expect.objectContaining({
				localToolCount: 0,
				attempts: 3,
			}),
		)
		expect(sentryMock.captureHomeConnectorMessage).toHaveBeenCalledWith(
			'Home connector local tool registry stayed empty.',
			expect.objectContaining({
				level: 'error',
				tags: expect.objectContaining({
					connector_event: 'tool_inventory.empty_local_registry',
				}),
			}),
		)
	} finally {
		connector.stop()
	}
})

test('empty tools/list responses do not reset empty registry retry counter', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const logger = createLogger()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger,
		toolRegistry: createRegisteredToolRegistry(() => []),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'empty-tools-1',
					method: 'tools/list',
				},
			}),
		)
		await vi.advanceTimersByTimeAsync(5_000)

		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'empty-tools-2',
					method: 'tools/list',
				},
			}),
		)
		await vi.advanceTimersByTimeAsync(10_000)

		expect(fakeWebSocketInstances).toHaveLength(1)
		expect(state.connection.connected).toBe(true)
		expect(state.connection.toolInventoryStatus).toBe('empty_local_registry')
		expect(state.connection.toolInventoryStatusReason).toContain(
			'stayed empty after retries',
		)
		expect(logger.error).toHaveBeenCalledWith(
			'worker.tools.empty_registry_persistent',
			'Home connector local tool registry stayed empty after retries.',
			expect.objectContaining({
				localToolCount: 0,
				attempts: 3,
			}),
		)
	} finally {
		connector.stop()
	}
})

test('empty tools/list polling does not postpone recovery timer', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const logger = createLogger()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger,
		toolRegistry: createRegisteredToolRegistry(() => []),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'empty-tools-1',
					method: 'tools/list',
				},
			}),
		)

		await vi.advanceTimersByTimeAsync(4_000)
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'empty-tools-2',
					method: 'tools/list',
				},
			}),
		)
		await vi.advanceTimersByTimeAsync(1_000)

		expect(countToolsChangedNotifications(socket)).toBe(2)
		expect(logger.warn).toHaveBeenCalledWith(
			'worker.tools.empty_registry_recovery',
			expect.stringContaining('attempt=1'),
			expect.objectContaining({
				attempt: 1,
			}),
		)
	} finally {
		connector.stop()
	}
})

test('remote list missing reason reflects recovery after an empty tools/list response', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	let tools: ReturnType<HomeConnectorToolRegistry['list']> = []
	const state = createAppState()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger: createLogger(),
		toolRegistry: createRegisteredToolRegistry(() => tools),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 'empty-tools',
					method: 'tools/list',
				},
			}),
		)

		tools = [bondShadeTool]
		await vi.advanceTimersByTimeAsync(15_000)

		expect(state.connection.connected).toBe(true)
		expect(state.connection.toolInventoryStatus).toBe('remote_list_missing')
		expect(state.connection.toolInventoryStatusReason).toContain(
			'Kody received an empty tools/list response',
		)
	} finally {
		connector.stop()
	}
})

test('connected websocket does not reconnect when local registry remains empty before tools/list', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const logger = createLogger()
	const connector = createWorkerConnector({
		config: createConfig(),
		state,
		logger,
		toolRegistry: createRegisteredToolRegistry(() => []),
	})

	try {
		await connector.start()
		const socket = fakeWebSocketInstances[0]
		if (!socket) throw new Error('Expected websocket instance')
		await socket.dispatchOpen()
		await socket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'default',
			}),
		)

		await vi.advanceTimersByTimeAsync(15_000)

		expect(fakeWebSocketInstances).toHaveLength(1)
		expect(state.connection.connected).toBe(true)
		expect(state.connection.toolInventoryStatus).toBe('empty_local_registry')
		expect(state.connection.toolInventoryStatusReason).toContain(
			'Kody did not request tools/list',
		)
		expect(state.connection.toolInventoryStatusReason).toContain(
			'stayed empty after retries',
		)
		expect(state.connection.toolInventoryRecoveryCount).toBe(0)
		expect(logger.error).toHaveBeenCalledWith(
			'worker.tools.empty_registry_persistent',
			'Home connector local tool registry stayed empty after retries.',
			expect.objectContaining({
				localToolCount: 0,
				attempts: 3,
			}),
		)
		expect(sentryMock.captureHomeConnectorMessage).toHaveBeenCalledWith(
			'Home connector local tool registry stayed empty.',
			expect.objectContaining({
				level: 'error',
				tags: expect.objectContaining({
					connector_event: 'tool_inventory.empty_local_registry',
				}),
			}),
		)
	} finally {
		connector.stop()
	}
})
