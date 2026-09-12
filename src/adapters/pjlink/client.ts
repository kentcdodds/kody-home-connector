import net from 'node:net'
import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'
import {
	computePjlinkAuthDigest,
	encodePjlinkCommand,
	parsePjlinkHandshake,
	parsePjlinkResponse,
	type PjlinkCommandName,
	type PjlinkHandshake,
} from './protocol.ts'
import { type PjlinkCommandClient } from './types.ts'

const defaultCommandTimeoutMs = 5_000
const defaultProbeTimeoutMs = 750

export class PjlinkUnreachableError extends Error {
	readonly host: string
	readonly port: number
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext

	constructor(input: { host: string; port: number; message: string }) {
		super(input.message)
		this.name = 'PjlinkUnreachableError'
		this.host = input.host
		this.port = input.port
		this.homeConnectorCaptureContext = {
			shouldCapture: false,
			tags: {
				connector_vendor: 'pjlink',
				pjlink_failure_class: 'unreachable',
			},
		}
	}
}

export function isPjlinkUnreachableError(
	error: unknown,
): error is PjlinkUnreachableError {
	return error instanceof PjlinkUnreachableError
}

export function isPjlinkUnreachableMessage(message: string) {
	const normalized = message.toLowerCase()
	return (
		normalized.includes('econnrefused') ||
		normalized.includes('ehostunreach') ||
		normalized.includes('enetunreach') ||
		normalized.includes('etimedout') ||
		normalized.includes('econnreset') ||
		normalized.includes('enotfound') ||
		normalized.includes('eai_again') ||
		normalized.includes('timed out') ||
		normalized.includes('unreachable')
	)
}

function toUnreachableError(input: {
	host: string
	port: number
	error: unknown
}) {
	if (isPjlinkUnreachableError(input.error)) return input.error
	const message =
		input.error instanceof Error ? input.error.message : String(input.error)
	if (!isPjlinkUnreachableMessage(message)) {
		return input.error
	}
	return new PjlinkUnreachableError({
		host: input.host,
		port: input.port,
		message: `PJLink projector at ${input.host}:${String(input.port)} is unreachable: ${message}`,
	})
}

function runPjlinkSocket<T>(input: {
	host: string
	port: number
	timeoutMs: number
	onConnect?: (socket: net.Socket) => void
	onLine: (line: string, lines: Array<string>, socket: net.Socket) => T | void
}): Promise<T> {
	return new Promise((resolve, reject) => {
		const socket = new net.Socket()
		let settled = false
		let buffer = ''
		const lines: Array<string> = []

		function finish(error: Error | null, value?: T) {
			if (settled) return
			settled = true
			socket.removeAllListeners()
			socket.destroy()
			if (error) {
				reject(error)
				return
			}
			if (value === undefined) {
				reject(new Error('PJLink session ended without a result.'))
				return
			}
			resolve(value)
		}

		socket.setTimeout(input.timeoutMs)
		socket.once('timeout', () => {
			finish(
				new Error(
					`PJLink command timed out after ${String(input.timeoutMs)}ms`,
				),
			)
		})
		socket.once('error', (error) => {
			finish(error)
		})
		socket.once('close', () => {
			if (!settled) {
				finish(
					new Error('PJLink connection closed before a complete response.'),
				)
			}
		})
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			while (buffer.includes('\r')) {
				const index = buffer.indexOf('\r')
				const line = buffer.slice(0, index).replaceAll('\n', '').trim()
				buffer = buffer.slice(index + 1)
				if (!line) continue
				lines.push(line)
				try {
					const result = input.onLine(line, lines, socket)
					if (result !== undefined) {
						finish(null, result)
					}
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)))
				}
			}
		})
		socket.connect(input.port, input.host, () => {
			input.onConnect?.(socket)
		})
	})
}

export function createTcpPjlinkCommandClient(input?: {
	timeoutMs?: number
}): PjlinkCommandClient {
	const defaultTimeoutMs = input?.timeoutMs ?? defaultCommandTimeoutMs
	return async ({ host, port, password, timeoutMs, command, parameter }) => {
		const timeout = timeoutMs ?? defaultTimeoutMs
		try {
			return await runPjlinkSocket({
				host,
				port,
				timeoutMs: timeout,
				onLine: (line, lines, socket) => {
					if (lines.length === 1) {
						const handshake = parsePjlinkHandshake(line)
						if (handshake.authRequired && !password) {
							throw new Error(
								`PJLink projector at ${host}:${String(port)} requires authentication, but no password is stored.`,
							)
						}
						const authDigest =
							handshake.authRequired && handshake.random && password
								? computePjlinkAuthDigest({
										random: handshake.random,
										password,
									})
								: null
						socket.write(
							encodePjlinkCommand({
								command: command as PjlinkCommandName,
								parameter,
								authDigest,
							}),
						)
						return
					}
					const handshake = parsePjlinkHandshake(lines[0] ?? '')
					const parsed = parsePjlinkResponse(line)
					return {
						handshake,
						value: parsed.value,
						raw: parsed.raw,
					}
				},
			})
		} catch (error) {
			throw toUnreachableError({ host, port, error })
		}
	}
}

export async function probePjlinkHandshake(input: {
	host: string
	port: number
	timeoutMs?: number
}): Promise<PjlinkHandshake> {
	const timeoutMs = input.timeoutMs ?? defaultProbeTimeoutMs
	try {
		return await runPjlinkSocket({
			host: input.host,
			port: input.port,
			timeoutMs,
			onLine: (line) => parsePjlinkHandshake(line),
		})
	} catch (error) {
		throw toUnreachableError({
			host: input.host,
			port: input.port,
			error,
		})
	}
}
