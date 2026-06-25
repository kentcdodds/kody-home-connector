import http from 'node:http'
import { afterEach, expect, test } from 'vitest'
import { createKasaKlapSubprocessClient } from './klap-subprocess-client.ts'
import {
	decryptKlapPayload,
	encryptKlapPayload,
	generateKlapAuthHash,
	generateKlapHandshake1Hash,
} from './klap-client.ts'

const servers: Array<http.Server> = []

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) reject(error)
						else resolve()
					})
				}),
		),
	)
	servers.length = 0
})

async function listen(server: http.Server) {
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	servers.push(server)
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Expected TCP server address.')
	}
	return address.port
}

async function readRequestBody(request: http.IncomingMessage) {
	const chunks: Array<Buffer> = []
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks)
}

function decryptKlapRequest(
	body: Buffer,
	input: {
		localSeed: Buffer
		remoteSeed: Buffer
		authHash: Buffer
		sequence: number
	},
) {
	return JSON.parse(
		decryptKlapPayload({
			localSeed: input.localSeed,
			remoteSeed: input.remoteSeed,
			authHash: input.authHash,
			sequence: input.sequence,
			payload: body,
		}),
	) as Record<string, unknown>
}

function respondToKlapSysinfoRequest(
	response: http.ServerResponse,
	input: {
		localSeed: Buffer
		remoteSeed: Buffer
		authHash: Buffer
		sequence: number
		payload: Record<string, unknown>
	},
) {
	response.end(
		encryptKlapPayload({
			localSeed: input.localSeed,
			remoteSeed: input.remoteSeed,
			authHash: input.authHash,
			sequence: input.sequence,
			payload: JSON.stringify({
				system: {
					get_sysinfo: {
						alias: 'Radon pumps',
						model: 'EP25',
						relay_state: 1,
					},
				},
			}),
		}),
	)
}

test('KLAP subprocess client reads sysinfo through an isolated Node worker', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials)
	let sessionLocalSeed: Buffer | null = null

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			sessionLocalSeed = body.subarray(0, 16)
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({
						localSeed: sessionLocalSeed,
						remoteSeed,
						authHash,
					}),
				]),
			)
			return
		}

		if (url.pathname === '/app/handshake2') {
			response.end()
			return
		}

		if (url.pathname === '/app/request') {
			if (!sessionLocalSeed) {
				response.statusCode = 500
				response.end()
				return
			}
			const sequence = Number(url.searchParams.get('seq'))
			const payload = decryptKlapRequest(body, {
				localSeed: sessionLocalSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			if (payload.method === 'get_device_info') {
				response.end(
					encryptKlapPayload({
						localSeed: sessionLocalSeed,
						remoteSeed,
						authHash,
						sequence,
						payload: JSON.stringify({ error_code: 0, result: {} }),
					}),
				)
				return
			}
			respondToKlapSysinfoRequest(response, {
				localSeed: sessionLocalSeed,
				remoteSeed,
				authHash,
				sequence,
				payload,
			})
			return
		}

		response.statusCode = 404
		response.end()
	})

	const port = await listen(server)
	const client = createKasaKlapSubprocessClient({
		host: '127.0.0.1',
		port,
		credentials,
		timeoutMs: 8_000,
	})

	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Radon pumps',
		model: 'EP25',
	})
})
