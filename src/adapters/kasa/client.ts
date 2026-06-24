import net from 'node:net'
import {
	type KasaClient,
	type KasaRelayState,
	type KasaSysInfo,
} from './types.ts'

const defaultKasaPort = 9999
const initialXorKey = 171
const maxKasaFramePayloadBytes = 1024 * 1024

export function encryptKasaPayload(payload: string) {
	let key = initialXorKey
	return Buffer.from(
		Buffer.from(payload, 'utf8').map((byte) => {
			const encrypted = byte ^ key
			key = encrypted
			return encrypted
		}),
	)
}

export function decryptKasaPayload(payload: Buffer) {
	let key = initialXorKey
	return Buffer.from(
		payload.map((byte) => {
			const decrypted = byte ^ key
			key = byte
			return decrypted
		}),
	).toString('utf8')
}

export function encodeKasaTcpRequest(payload: Record<string, unknown>) {
	const encrypted = encryptKasaPayload(JSON.stringify(payload))
	const frame = Buffer.alloc(4 + encrypted.length)
	frame.writeUInt32BE(encrypted.length, 0)
	encrypted.copy(frame, 4)
	return frame
}

export function decodeKasaTcpResponse(frame: Buffer) {
	if (frame.length < 4) {
		throw new Error('Kasa response frame is shorter than the 4-byte length.')
	}
	const length = frame.readUInt32BE(0)
	if (frame.length < 4 + length) {
		throw new Error(
			`Kasa response frame is incomplete (${String(frame.length - 4)} of ${String(length)} bytes).`,
		)
	}
	const payload = decryptKasaPayload(frame.subarray(4, 4 + length))
	return JSON.parse(payload) as Record<string, unknown>
}

function getSystemResponse(
	response: Record<string, unknown>,
	command: string,
): Record<string, unknown> {
	const system = response['system']
	if (!system || typeof system !== 'object' || Array.isArray(system)) {
		throw new Error('Kasa response did not include a system object.')
	}
	const commandResponse = (system as Record<string, unknown>)[command]
	if (
		!commandResponse ||
		typeof commandResponse !== 'object' ||
		Array.isArray(commandResponse)
	) {
		throw new Error(`Kasa response did not include system.${command}.`)
	}
	const record = commandResponse as Record<string, unknown>
	const errCode = record['err_code']
	if (typeof errCode === 'number' && errCode !== 0) {
		throw new Error(
			`Kasa system.${command} failed with err_code ${String(errCode)}.`,
		)
	}
	return record
}

async function sendKasaTcpCommand(input: {
	host: string
	port?: number
	payload: Record<string, unknown>
	timeoutMs?: number
}) {
	const port = input.port ?? defaultKasaPort
	const timeoutMs = input.timeoutMs ?? 5_000
	const request = encodeKasaTcpRequest(input.payload)

	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		const socket = net.createConnection({ host: input.host, port })
		const chunks: Array<Buffer> = []
		let settled = false
		let expectedLength: number | null = null

		function cleanup() {
			socket.removeAllListeners()
			socket.destroy()
		}

		function settleError(error: unknown) {
			if (settled) return
			settled = true
			cleanup()
			reject(error)
		}

		function settleValue(value: Record<string, unknown>) {
			if (settled) return
			settled = true
			cleanup()
			resolve(value)
		}

		socket.setTimeout(timeoutMs, () => {
			settleError(
				new Error(
					`Kasa request to ${input.host}:${String(port)} timed out after ${String(timeoutMs)}ms.`,
				),
			)
		})
		socket.setNoDelay(true)

		socket.on('connect', () => {
			socket.write(request)
		})
		socket.on('data', (chunk) => {
			chunks.push(chunk)
			const frame = Buffer.concat(chunks)
			if (expectedLength == null && frame.length >= 4) {
				expectedLength = frame.readUInt32BE(0)
				if (expectedLength > maxKasaFramePayloadBytes) {
					settleError(
						new Error(
							`Kasa response frame is too large (${String(expectedLength)} bytes).`,
						),
					)
					return
				}
			}
			if (expectedLength != null && frame.length >= 4 + expectedLength) {
				try {
					settleValue(decodeKasaTcpResponse(frame))
				} catch (error) {
					settleError(error)
				}
			}
		})
		socket.on('error', settleError)
		socket.on('close', () => {
			if (!settled) {
				settleError(
					new Error(
						`Kasa connection to ${input.host}:${String(port)} closed before a complete response.`,
					),
				)
			}
		})
	})
}

export function createKasaLegacyClient(): KasaClient {
	return {
		async getSysInfo(input) {
			const response = await sendKasaTcpCommand({
				host: input.host,
				port: input.port,
				timeoutMs: input.timeoutMs,
				payload: {
					system: {
						get_sysinfo: {},
					},
				},
			})
			return getSystemResponse(response, 'get_sysinfo') as KasaSysInfo
		},
		async setRelayState(input) {
			const state: KasaRelayState = input.state === 1 ? 1 : 0
			const response = await sendKasaTcpCommand({
				host: input.host,
				port: input.port,
				timeoutMs: input.timeoutMs,
				payload: {
					system: {
						set_relay_state: {
							state,
						},
					},
				},
			})
			return getSystemResponse(response, 'set_relay_state')
		},
	}
}
