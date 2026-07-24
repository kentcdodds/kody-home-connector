import { expect, test, vi } from 'vitest'
import { sendJellyfishCommand } from './client.ts'

test('jellyfish transport timeouts annotate hourly dedupe metadata', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-22T23:34:17.000Z'))

	const previousWebSocket = globalThis.WebSocket
	class FakeWebSocket {
		static CONNECTING = 0
		static OPEN = 1
		static CLOSING = 2
		static CLOSED = 3
		readyState = FakeWebSocket.CONNECTING
		onopen: ((event: Event) => void) | null = null
		onmessage: ((event: MessageEvent) => void) | null = null
		onerror: ((event: Event) => void) | null = null
		onclose: ((event: CloseEvent) => void) | null = null
		send() {}
		close() {
			this.readyState = FakeWebSocket.CLOSED
		}
	}
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

	try {
		const pending = sendJellyfishCommand({
			host: '192.168.0.93',
			port: 9000,
			command: { cmd: 'toCtlrGet', get: [['zones']] },
			timeoutMs: 15_000,
			mocksEnabled: false,
		})
		const expectation = expect(pending).rejects.toMatchObject({
			name: 'JellyfishTransportError',
			message:
				'JellyFish command timed out after 15000ms for 192.168.0.93:9000.',
			homeConnectorCaptureContext: {
				tags: {
					connector_vendor: 'jellyfish',
					jellyfish_host: '192.168.0.93',
					jellyfish_port: '9000',
					jellyfish_failure_cause_class: 'timeout',
				},
				dedupe: {
					ttlMs: 60 * 60 * 1000,
				},
			},
		})
		await vi.advanceTimersByTimeAsync(15_000)
		await expectation
	} finally {
		globalThis.WebSocket = previousWebSocket
		vi.useRealTimers()
	}
})
