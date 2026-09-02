import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import {
	authorizePhoneUpgrade,
	createPhoneAdapter,
	handlePhoneHttpUpgrade,
	isPhoneWebSocketUpgradePath,
	phoneWebSocketPath,
} from './index.ts'

class FakePhoneSocket extends EventEmitter {
	readonly sent: Array<string> = []
	closed = false

	send(data: string) {
		this.sent.push(data)
	}

	close() {
		if (this.closed) return
		this.closed = true
		this.emit('close')
	}

	receive(message: unknown) {
		this.emit('message', JSON.stringify(message))
	}

	parsedSent() {
		return this.sent.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>,
		)
	}
}

class FakeUpgradeSocket {
	readonly writes: Array<string> = []
	destroyed = false

	write(chunk: string) {
		this.writes.push(chunk)
		return true
	}

	destroy() {
		this.destroyed = true
	}
}

const hello = {
	type: 'hello' as const,
	protocolVersion: 1 as const,
	deviceId: 'pixel-9',
	deviceName: 'Kent Pixel',
	androidVersion: '16',
	sdkInt: 36,
	appVersion: '1.0.0',
}

function createAdapter(token: string | null = 'phone-token') {
	let callId = 0
	return createPhoneAdapter({
		config: createTestHomeConnectorConfig({
			phoneDeviceToken: token,
			publicBaseUrl: 'https://kody-home.doddsfamily.us',
		}),
		createCallId: () => {
			callId += 1
			return `call-${String(callId)}`
		},
	})
}

async function connectPhone(
	phone: ReturnType<typeof createPhoneAdapter>,
	socket = new FakePhoneSocket(),
) {
	phone.accept(socket)
	socket.receive(hello)
	return socket
}

test('authorizePhoneUpgrade accepts query, header, and bearer tokens', () => {
	const expectedToken = 'phone-token'
	expect(
		authorizePhoneUpgrade({
			request: { url: '/phone/ws?token=phone-token', headers: {} },
			expectedToken,
		}),
	).toEqual({ ok: true })
	expect(
		authorizePhoneUpgrade({
			request: {
				url: '/phone/ws',
				headers: { 'x-phone-token': 'phone-token' },
			},
			expectedToken,
		}),
	).toEqual({ ok: true })
	expect(
		authorizePhoneUpgrade({
			request: {
				url: '/phone/ws',
				headers: { authorization: 'Bearer phone-token' },
			},
			expectedToken,
		}),
	).toEqual({ ok: true })
})

test('authorizePhoneUpgrade prefers query token over later sources', () => {
	expect(
		authorizePhoneUpgrade({
			request: {
				url: '/phone/ws?token=wrong',
				headers: {
					'x-phone-token': 'phone-token',
					authorization: 'Bearer phone-token',
				},
			},
			expectedToken: 'phone-token',
		}),
	).toMatchObject({ ok: false, status: 401 })
})

test('authorizePhoneUpgrade rejects missing, wrong, and unconfigured tokens', () => {
	expect(
		authorizePhoneUpgrade({
			request: { url: '/phone/ws', headers: {} },
			expectedToken: null,
		}),
	).toMatchObject({
		ok: false,
		status: 503,
		reason: 'Phone token not configured.',
	})
	expect(
		authorizePhoneUpgrade({
			request: { url: '/phone/ws', headers: {} },
			expectedToken: 'phone-token',
		}),
	).toMatchObject({ ok: false, status: 401 })
	expect(
		authorizePhoneUpgrade({
			request: {
				url: '/phone/ws',
				headers: { 'x-phone-token': 'nope' },
			},
			expectedToken: 'phone-token',
		}),
	).toMatchObject({ ok: false, status: 401 })
	expect(
		authorizePhoneUpgrade({
			request: {
				url: '/phone/ws?token=phone-tokenX',
				headers: {},
			},
			expectedToken: 'phone-token',
		}),
	).toMatchObject({ ok: false, status: 401 })
})

test('hello is acknowledged and call/result round-trips', async () => {
	const phone = createAdapter()
	const socket = await connectPhone(phone)
	expect(socket.parsedSent()).toEqual([
		{ type: 'hello_ack', protocolVersion: 1 },
	])
	expect(phone.getStatus()).toMatchObject({
		connected: true,
		tokenConfigured: true,
		deviceId: 'pixel-9',
		lastHello: {
			deviceName: 'Kent Pixel',
			appVersion: '1.0.0',
			sdkInt: 36,
		},
	})

	const pending = phone.call('phone_network', {})
	expect(socket.parsedSent()[1]).toEqual({
		type: 'call',
		id: 'call-1',
		tool: 'phone_network',
		args: {},
	})
	socket.receive({
		type: 'result',
		id: 'call-1',
		ok: true,
		payload: { ssid: 'Dodds', vpn: false },
	})
	await expect(pending).resolves.toEqual({
		ok: true,
		payload: { ssid: 'Dodds', vpn: false },
	})
})

test('call times out when the phone never returns a result', async () => {
	const phone = createPhoneAdapter({
		config: createTestHomeConnectorConfig({
			phoneDeviceToken: 'phone-token',
		}),
		createCallId: () => 'timeout-1',
		defaultTimeoutMs: 20,
	})
	await connectPhone(phone)
	await expect(phone.call('phone_status')).resolves.toMatchObject({
		ok: false,
		error: { code: 'phone_timeout' },
	})
})

test('offline and missing-token calls return structured errors', async () => {
	const offline = createAdapter()
	await expect(offline.call('phone_network')).resolves.toEqual({
		ok: false,
		error: {
			code: 'phone_offline',
			message: 'No Android companion is connected.',
		},
	})

	const unconfigured = createAdapter(null)
	await expect(unconfigured.call('phone_network')).resolves.toEqual({
		ok: false,
		error: {
			code: 'phone_token_not_configured',
			message: 'Phone token not configured.',
		},
	})
	expect(unconfigured.getCallReadiness()).toMatchObject({
		error: { code: 'phone_token_not_configured' },
	})
})

test('a newer deviceId replaces the previous primary socket', async () => {
	const phone = createAdapter()
	const first = await connectPhone(phone)
	const second = new FakePhoneSocket()
	phone.accept(second)
	second.receive({
		...hello,
		deviceId: 'pixel-fold',
		deviceName: 'Kent Fold',
	})
	expect(first.closed).toBe(true)
	expect(phone.getStatus()).toMatchObject({
		connected: true,
		deviceId: 'pixel-fold',
		lastHello: { deviceName: 'Kent Fold' },
	})
})

test('ping from the phone is answered with pong', async () => {
	const phone = createAdapter()
	const socket = await connectPhone(phone)
	socket.receive({ type: 'ping', id: 'keep-alive' })
	expect(socket.parsedSent()).toContainEqual({
		type: 'pong',
		id: 'keep-alive',
	})
})

test('upgrade path is /phone/ws not /phone', () => {
	expect(isPhoneWebSocketUpgradePath('/phone/ws')).toBe(true)
	expect(isPhoneWebSocketUpgradePath('/phone')).toBe(false)
	expect(phoneWebSocketPath).toBe('/phone/ws')

	const phone = createAdapter()
	const phoneRoot = new FakeUpgradeSocket()
	const handledRoot = handlePhoneHttpUpgrade({
		request: {
			url: '/phone?token=phone-token',
			headers: {},
		} as IncomingMessage,
		socket: phoneRoot as unknown as Parameters<
			typeof handlePhoneHttpUpgrade
		>[0]['socket'],
		head: Buffer.alloc(0),
		phone,
		webSocketServer: {
			handleUpgrade() {
				throw new Error('should not upgrade /phone')
			},
		},
	})
	expect(handledRoot).toBe(true)
	expect(phoneRoot.destroyed).toBe(true)
	expect(phoneRoot.writes[0]).toContain('404')

	let accepted = false
	const wsSocket = new FakeUpgradeSocket()
	const handledWs = handlePhoneHttpUpgrade({
		request: {
			url: '/phone/ws?token=phone-token',
			headers: {},
		} as IncomingMessage,
		socket: wsSocket as unknown as Parameters<
			typeof handlePhoneHttpUpgrade
		>[0]['socket'],
		head: Buffer.alloc(0),
		phone,
		webSocketServer: {
			handleUpgrade(_request, _socket, _head, callback) {
				accepted = true
				callback(new FakePhoneSocket() as never)
			},
		},
	})
	expect(handledWs).toBe(true)
	expect(accepted).toBe(true)
	expect(wsSocket.destroyed).toBe(false)
})
