import { afterEach, expect, test, vi } from 'vitest'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorLogger } from '../logging/index.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'
import { createAppState } from '../state.ts'
import { createWorkerConnectorSessions } from './worker-connector-sessions.ts'

type FakeWebSocketListener = (event: {
	data?: string
	code?: number
	reason?: string
	wasClean?: boolean
	type?: string
}) => void

const fakeWebSocketInstances: Array<FakeWorkerWebSocket> = []
const originalWebSocket = globalThis.WebSocket

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
		this.readyState = FakeWorkerWebSocket.CLOSED
		for (const listener of this.listeners.get('close') ?? []) {
			listener({ code, reason, wasClean: true, type: 'close' })
		}
	}

	async dispatchOpen() {
		this.readyState = FakeWorkerWebSocket.OPEN
		for (const listener of this.listeners.get('open') ?? []) {
			listener({ type: 'open' })
		}
	}

	async dispatchMessage(data: string) {
		for (const listener of this.listeners.get('message') ?? []) {
			await listener({ data, type: 'message' })
		}
	}
}

afterEach(() => {
	globalThis.WebSocket = originalWebSocket
	fakeWebSocketInstances.length = 0
	vi.clearAllMocks()
	vi.useRealTimers()
})

function createConfig(): HomeConnectorConfig {
	return {
		homeConnectorId: 'home',
		kodyUsername: 'alice',
		workerBaseUrl: 'https://heykody.app',
		workerSessionUrl: 'https://heykody.app/@alice/connectors/home',
		workerWebSocketUrl: 'wss://heykody.app/@alice/connectors/home',
		sharedSecret: 'secret-a',
		workerTargets: [
			{
				kodyUsername: 'alice',
				homeConnectorId: 'home',
				sharedSecret: 'secret-a',
				workerBaseUrl: 'https://heykody.app',
				workerSessionUrl: 'https://heykody.app/@alice/connectors/home',
				workerWebSocketUrl: 'wss://heykody.app/@alice/connectors/home',
			},
			{
				kodyUsername: 'bob',
				homeConnectorId: 'home',
				sharedSecret: 'secret-b',
				workerBaseUrl: 'https://heykody.app',
				workerSessionUrl: 'https://heykody.app/@bob/connectors/home',
				workerWebSocketUrl: 'wss://heykody.app/@bob/connectors/home',
			},
		],
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: false,
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
		list: vi.fn(() => [
			{
				name: 'demo_tool',
				description: 'demo',
				inputSchema: { type: 'object', properties: {} },
			},
		]),
		call: vi.fn(async () => ({
			content: [{ type: 'text', text: 'ok' }],
		})),
	}
}

function getSentMessage(socket: FakeWorkerWebSocket, index: number) {
	const raw = socket.sentMessages[index]
	expect(raw).toBeTypeOf('string')
	return JSON.parse(raw!) as Record<string, unknown>
}

test('starts one websocket session per target and fans out tools/list_changed', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const toolRegistry = createToolRegistry()
	const sessions = createWorkerConnectorSessions({
		config: createConfig(),
		state,
		logger: createLogger(),
		toolRegistry,
	})

	try {
		expect(sessions.sessionCount).toBe(2)
		expect(state.workerSessions).toHaveLength(2)
		expect(state.workerSessions.map((session) => session.sessionKey)).toEqual([
			'alice/home',
			'bob/home',
		])

		await sessions.start()
		expect(fakeWebSocketInstances).toHaveLength(2)
		expect(fakeWebSocketInstances[0]?.url).toBe(
			'wss://heykody.app/@alice/connectors/home',
		)
		expect(fakeWebSocketInstances[1]?.url).toBe(
			'wss://heykody.app/@bob/connectors/home',
		)

		const aliceSocket = fakeWebSocketInstances[0]!
		const bobSocket = fakeWebSocketInstances[1]!
		await aliceSocket.dispatchOpen()
		await bobSocket.dispatchOpen()
		expect(getSentMessage(aliceSocket, 0)).toMatchObject({
			type: 'connector.hello',
			connectorId: 'home',
			sharedSecret: 'secret-a',
		})
		expect(getSentMessage(bobSocket, 0)).toMatchObject({
			type: 'connector.hello',
			connectorId: 'home',
			sharedSecret: 'secret-b',
		})

		await aliceSocket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'home',
			}),
		)

		const hasListChanged = (socket: FakeWorkerWebSocket) =>
			socket.sentMessages.some((raw) => {
				const message = JSON.parse(raw) as {
					type?: string
					message?: { method?: string }
				}
				return (
					message.type === 'connector.jsonrpc' &&
					message.message?.method === 'notifications/tools/list_changed'
				)
			})
		// Alice's ack fans tools/list_changed out to every open session socket.
		expect(hasListChanged(aliceSocket)).toBe(true)
		expect(hasListChanged(bobSocket)).toBe(true)
		expect(state.workerSessions[0]?.connected).toBe(true)
		expect(state.workerSessions[1]?.connected).toBe(false)
		expect(state.connection.connected).toBe(true)
		expect(state.connection.kodyUsername).toBe('alice')
		expect(toolRegistry.list).toHaveBeenCalled()

		await bobSocket.dispatchMessage(
			JSON.stringify({
				type: 'server.ack',
				connectorId: 'home',
			}),
		)
		expect(state.workerSessions[1]?.connected).toBe(true)

		await bobSocket.dispatchMessage(
			JSON.stringify({
				type: 'connector.jsonrpc',
				message: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
				},
			}),
		)
		expect(state.workerSessions[1]?.toolInventoryStatus).toBe('registered')

		const bobListChangedBefore = bobSocket.sentMessages.filter((raw) => {
			const message = JSON.parse(raw) as {
				type?: string
				message?: { method?: string }
			}
			return (
				message.type === 'connector.jsonrpc' &&
				message.message?.method === 'notifications/tools/list_changed'
			)
		}).length

		// A later alice refresh must fan out on the wire without regressing bob.
		sessions.notifyToolsListChanged('manual-refresh')
		expect(state.workerSessions[1]?.toolInventoryStatus).toBe('registered')
		expect(
			bobSocket.sentMessages.filter((raw) => {
				const message = JSON.parse(raw) as {
					type?: string
					message?: { method?: string }
				}
				return (
					message.type === 'connector.jsonrpc' &&
					message.message?.method === 'notifications/tools/list_changed'
				)
			}).length,
		).toBeGreaterThan(bobListChangedBefore)
	} finally {
		sessions.stop()
	}
})

test('one session close does not stop the other session', async () => {
	vi.useFakeTimers()
	globalThis.WebSocket = FakeWorkerWebSocket as unknown as typeof WebSocket
	const state = createAppState()
	const sessions = createWorkerConnectorSessions({
		config: createConfig(),
		state,
		logger: createLogger(),
		toolRegistry: createToolRegistry(),
	})

	try {
		await sessions.start()
		const aliceSocket = fakeWebSocketInstances[0]!
		const bobSocket = fakeWebSocketInstances[1]!
		await aliceSocket.dispatchOpen()
		await bobSocket.dispatchOpen()
		await aliceSocket.dispatchMessage(
			JSON.stringify({ type: 'server.ack', connectorId: 'home' }),
		)
		await bobSocket.dispatchMessage(
			JSON.stringify({ type: 'server.ack', connectorId: 'home' }),
		)

		aliceSocket.close(1006, 'boom')
		expect(state.workerSessions[0]?.connected).toBe(false)
		expect(state.workerSessions[1]?.connected).toBe(true)
		expect(state.connection.connected).toBe(false)
		expect(bobSocket.readyState).toBe(FakeWorkerWebSocket.OPEN)
	} finally {
		sessions.stop()
	}
})
