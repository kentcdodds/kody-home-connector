import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
	defaultHomeLanListenHost,
	type HomeConnectorConfig,
} from '../../config.ts'
import { type HomeConnectorLogger } from '../../logging/index.ts'
import {
	authorizePhoneUpgrade,
	getUpgradePathname,
	isPhoneWebSocketUpgradePath,
} from './auth.ts'
import {
	phoneDefaultRpcTimeoutMs,
	phoneMdnsScanTimeoutMs,
	phoneOfflineError,
	phoneProtocolVersion,
	phoneTimeoutError,
	phoneTokenNotConfiguredError,
	phoneWebSocketPath,
	type PhoneCallResult,
	type PhoneClientMessage,
	type PhoneConnectionStatus,
	type PhoneHelloInfo,
	type PhoneServerMessage,
	type PhoneSocket,
	type PhoneStructuredError,
	type PhoneUpgradeRequest,
} from './types.ts'

export {
	authorizePhoneUpgrade,
	extractPhoneDeviceToken,
	getUpgradePathname,
	isPhoneWebSocketUpgradePath,
} from './auth.ts'
export {
	defaultCastMdnsServiceType,
	defaultPhonePermissionPackages,
	gmsPackageName,
	googleHomePackageName,
	phoneDefaultRpcTimeoutMs,
	phoneMdnsScanTimeoutMs,
	phoneOfflineError,
	phoneProtocolVersion,
	phoneTimeoutError,
	phoneTokenNotConfiguredError,
	phoneWebSocketPath,
	teslaPackageName,
	youtubePackageName,
} from './types.ts'
export type {
	PhoneCallResult,
	PhoneConnectionStatus,
	PhoneHelloInfo,
	PhoneSocket,
	PhoneStructuredError,
	PhoneUpgradeRequest,
} from './types.ts'

type PendingCall = {
	resolve: (result: PhoneCallResult) => void
	timer: ReturnType<typeof setTimeout>
}

type PhoneSession = {
	generation: number
	socket: PhoneSocket
	hello: PhoneHelloInfo | null
	pending: Map<string, PendingCall>
}

type PhoneHttpUpgradeSocket = Duplex & {
	write(chunk: string): unknown
}

function socketDataToString(data: unknown) {
	if (typeof data === 'string') return data
	if (Buffer.isBuffer(data)) return data.toString('utf8')
	if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
	if (data && typeof data === 'object' && 'toString' in data) {
		return String(data)
	}
	return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readNonEmptyString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseClientMessage(raw: unknown): PhoneClientMessage | null {
	if (!isRecord(raw)) return null
	const type = raw['type']
	if (
		type !== 'hello' &&
		type !== 'result' &&
		type !== 'ping' &&
		type !== 'pong'
	) {
		return null
	}

	switch (type) {
		case 'hello': {
			const deviceId = readNonEmptyString(raw['deviceId'])
			const deviceName = readNonEmptyString(raw['deviceName'])
			const androidVersion = readNonEmptyString(raw['androidVersion'])
			const appVersion = readNonEmptyString(raw['appVersion'])
			const sdkInt = raw['sdkInt']
			if (
				raw['protocolVersion'] !== phoneProtocolVersion ||
				!deviceId ||
				!deviceName ||
				!androidVersion ||
				!appVersion ||
				typeof sdkInt !== 'number' ||
				!Number.isFinite(sdkInt)
			) {
				return null
			}
			return {
				type: 'hello',
				protocolVersion: phoneProtocolVersion,
				deviceId,
				deviceName,
				androidVersion,
				sdkInt,
				appVersion,
			}
		}
		case 'result': {
			const id = readNonEmptyString(raw['id'])
			if (!id) return null
			if (raw['ok'] === true) {
				return {
					type: 'result',
					id,
					ok: true,
					payload: raw['payload'],
				}
			}
			if (raw['ok'] !== false || !isRecord(raw['error'])) return null
			const code = readNonEmptyString(raw['error']['code'])
			const message = readNonEmptyString(raw['error']['message'])
			if (!code || !message) return null
			return {
				type: 'result',
				id,
				ok: false,
				error: { code, message },
			}
		}
		case 'ping':
		case 'pong': {
			const id = readNonEmptyString(raw['id'])
			if (!id) return null
			return { type, id }
		}
		default: {
			const _never: never = type
			return _never
		}
	}
}

function toWebSocketOrigin(httpOrigin: string) {
	if (httpOrigin.startsWith('https://')) {
		return `wss://${httpOrigin.slice('https://'.length)}`
	}
	if (httpOrigin.startsWith('http://')) {
		return `ws://${httpOrigin.slice('http://'.length)}`
	}
	return httpOrigin
}

function structuredError(error: {
	code: string
	message: string
}): PhoneStructuredError {
	return {
		ok: false,
		error: {
			code: error.code,
			message: error.message,
		},
	}
}

function rejectHttpUpgrade(
	socket: PhoneHttpUpgradeSocket,
	status: number,
	statusText: string,
) {
	try {
		socket.write(
			`HTTP/1.1 ${String(status)} ${statusText}\r\nConnection: close\r\n\r\n`,
		)
	} catch {
		// The TCP socket may already be gone; destroy either way.
	}
	socket.destroy()
}

export function createPhoneAdapter(input: {
	config: HomeConnectorConfig
	logger?: HomeConnectorLogger
	now?: () => Date
	createCallId?: () => string
	defaultTimeoutMs?: number
}) {
	const expectedToken = input.config.phoneDeviceToken
	const defaultTimeoutMs = input.defaultTimeoutMs ?? phoneDefaultRpcTimeoutMs
	const createCallId = input.createCallId ?? (() => randomUUID())
	const now = () => (input.now ? input.now() : new Date())

	let primary: PhoneSession | null = null
	let nextGeneration = 0
	let lastHello: PhoneHelloInfo | null = null
	let lastSeenAt: string | null = null
	let connectedAt: string | null = null

	function isoNow() {
		return now().toISOString()
	}

	function send(session: PhoneSession, message: PhoneServerMessage) {
		session.socket.send(JSON.stringify(message))
	}

	function failPending(session: PhoneSession, error: PhoneStructuredError) {
		for (const pending of session.pending.values()) {
			clearTimeout(pending.timer)
			pending.resolve(error)
		}
		session.pending.clear()
	}

	function dropSession(session: PhoneSession, replaced: boolean) {
		if (primary === session) {
			primary = null
			connectedAt = null
		}
		failPending(
			session,
			structuredError(
				replaced
					? {
							code: 'phone_replaced',
							message:
								'The Android companion connection was replaced by a newer socket.',
						}
					: phoneOfflineError,
			),
		)
		try {
			session.socket.close()
		} catch {
			// Ignore sockets that are already closing.
		}
	}

	function setPrimary(session: PhoneSession) {
		if (primary === session) return true
		if (primary && session.generation < primary.generation) {
			dropSession(session, true)
			return false
		}
		if (primary) {
			const previous = primary
			primary = session
			dropSession(previous, true)
			return true
		}
		primary = session
		return true
	}

	function handleClientMessage(
		session: PhoneSession,
		message: PhoneClientMessage,
	) {
		switch (message.type) {
			case 'hello': {
				session.hello = {
					protocolVersion: message.protocolVersion,
					deviceId: message.deviceId,
					deviceName: message.deviceName,
					androidVersion: message.androidVersion,
					sdkInt: message.sdkInt,
					appVersion: message.appVersion,
				}
				const wasPrimary = primary === session
				if (!setPrimary(session)) return
				lastHello = session.hello
				lastSeenAt = isoNow()
				if (!wasPrimary) {
					connectedAt = lastSeenAt
				}
				send(session, {
					type: 'hello_ack',
					protocolVersion: phoneProtocolVersion,
				})
				input.logger?.info(
					'phone.connected',
					`Android companion connected deviceId=${message.deviceId}`,
					{
						deviceId: message.deviceId,
						deviceName: message.deviceName,
						androidVersion: message.androidVersion,
						sdkInt: message.sdkInt,
						appVersion: message.appVersion,
					},
				)
				return
			}
			case 'result': {
				if (session === primary) {
					lastSeenAt = isoNow()
				}
				const pending = session.pending.get(message.id)
				if (!pending) return
				session.pending.delete(message.id)
				clearTimeout(pending.timer)
				if (message.ok) {
					pending.resolve({ ok: true, payload: message.payload })
					return
				}
				pending.resolve(structuredError(message.error))
				return
			}
			case 'ping': {
				if (session === primary) {
					lastSeenAt = isoNow()
				}
				send(session, { type: 'pong', id: message.id })
				return
			}
			case 'pong': {
				if (session === primary) {
					lastSeenAt = isoNow()
				}
				return
			}
			default: {
				const _never: never = message
				void _never
			}
		}
	}

	function accept(ws: PhoneSocket) {
		nextGeneration += 1
		const session: PhoneSession = {
			generation: nextGeneration,
			socket: ws,
			hello: null,
			pending: new Map(),
		}

		ws.on('message', (data) => {
			const text = socketDataToString(data)
			if (text == null) return
			try {
				const parsed: unknown = JSON.parse(text)
				const message = parseClientMessage(parsed)
				if (!message) return
				handleClientMessage(session, message)
			} catch {
				// Ignore malformed frames; the next valid object can continue the session.
			}
		})

		ws.on('close', () => {
			if (primary === session) {
				primary = null
				connectedAt = null
				lastSeenAt = isoNow()
				input.logger?.info(
					'phone.disconnected',
					'Android companion disconnected',
					{
						deviceId: session.hello?.deviceId ?? null,
					},
				)
			}
			failPending(session, structuredError(phoneOfflineError))
		})

		ws.on('error', () => {
			// Close handling below is enough; avoid throwing out of the socket.
		})
	}

	function getCallReadiness(): PhoneStructuredError | null {
		if (!expectedToken) {
			return structuredError(phoneTokenNotConfiguredError)
		}
		if (!primary?.hello) {
			return structuredError(phoneOfflineError)
		}
		return null
	}

	function call(
		tool: string,
		args: Record<string, unknown> = {},
		options: { timeoutMs?: number } = {},
	): Promise<PhoneCallResult> {
		const blocked = getCallReadiness()
		if (blocked) return Promise.resolve(blocked)
		const session = primary
		if (!session) return Promise.resolve(structuredError(phoneOfflineError))

		const id = createCallId()
		const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!session.pending.delete(id)) return
				resolve(structuredError(phoneTimeoutError))
			}, timeoutMs)
			session.pending.set(id, { resolve, timer })
			try {
				send(session, {
					type: 'call',
					id,
					tool,
					args,
				})
			} catch (error) {
				session.pending.delete(id)
				clearTimeout(timer)
				resolve(
					structuredError({
						code: 'phone_send_failed',
						message:
							error instanceof Error
								? error.message
								: 'Failed to send a call to the Android companion.',
					}),
				)
			}
		})
	}

	function authorizeUpgrade(request: PhoneUpgradeRequest) {
		return authorizePhoneUpgrade({
			request,
			expectedToken,
		})
	}

	function getStatus(): PhoneConnectionStatus {
		return {
			tokenConfigured: Boolean(expectedToken),
			connected: Boolean(primary?.hello),
			websocketPath: phoneWebSocketPath,
			publicWebSocketUrl: `${toWebSocketOrigin(input.config.publicBaseUrl)}${phoneWebSocketPath}`,
			localWebSocketUrl: `ws://127.0.0.1:${String(input.config.port)}${phoneWebSocketPath}`,
			lanWebSocketUrl: `ws://${defaultHomeLanListenHost}:${String(input.config.port)}${phoneWebSocketPath}`,
			lastHello,
			lastSeenAt,
			connectedAt,
			deviceId: primary?.hello?.deviceId ?? lastHello?.deviceId ?? null,
		}
	}

	return {
		authorizeUpgrade,
		accept,
		call,
		getStatus,
		getCallReadiness,
		mdnsScanTimeoutMs: phoneMdnsScanTimeoutMs,
	}
}

export function handlePhoneHttpUpgrade(input: {
	request: IncomingMessage
	socket: PhoneHttpUpgradeSocket
	head: Buffer
	phone: ReturnType<typeof createPhoneAdapter>
	webSocketServer: Pick<WebSocketServer, 'handleUpgrade'>
}) {
	const pathname = getUpgradePathname(input.request.url)
	if (!isPhoneWebSocketUpgradePath(pathname)) {
		if (pathname === '/phone' || pathname.startsWith('/phone/')) {
			rejectHttpUpgrade(input.socket, 404, 'Not Found')
			return true
		}
		return false
	}

	const auth = input.phone.authorizeUpgrade(input.request)
	if (!auth.ok) {
		rejectHttpUpgrade(input.socket, auth.status, auth.statusText)
		return true
	}

	input.webSocketServer.handleUpgrade(
		input.request,
		input.socket,
		input.head,
		(ws: WebSocket) => {
			input.phone.accept(ws)
		},
	)
	return true
}

export function attachPhoneWebSocketUpgrade(input: {
	server: {
		on(
			event: 'upgrade',
			listener: (
				request: IncomingMessage,
				socket: Duplex,
				head: Buffer,
			) => void,
		): unknown
	}
	phone: ReturnType<typeof createPhoneAdapter>
	webSocketServer?: WebSocketServer
}) {
	const webSocketServer =
		input.webSocketServer ?? new WebSocketServer({ noServer: true })
	input.server.on('upgrade', (request, socket, head) => {
		const handled = handlePhoneHttpUpgrade({
			request,
			socket,
			head,
			phone: input.phone,
			webSocketServer,
		})
		if (!handled) {
			socket.destroy()
		}
	})
	return webSocketServer
}
