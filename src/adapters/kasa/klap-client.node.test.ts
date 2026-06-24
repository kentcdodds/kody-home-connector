import http from 'node:http'
import { Buffer } from 'node:buffer'
import { afterEach, expect, test } from 'vitest'
import {
	createKasaKlapClient,
	decryptKlapPayload,
	deriveKlapIv,
	encryptKlapPayload,
	generateKlapAuthHash,
	generateKlapHandshake1Hash,
	generateKlapHandshake2Hash,
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

function readRequestBody(request: http.IncomingMessage) {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Array<Buffer> = []
		request.on('data', (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		})
		request.on('end', () => resolve(Buffer.concat(chunks)))
		request.on('error', reject)
	})
}

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

test('KLAP frame encryption and decryption use the same sequence IV', () => {
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash({
		username: 'kent@example.com',
		password: 'secret-password',
	})
	const sequence =
		deriveKlapIv({ localSeed, remoteSeed, authHash }).sequence + 1
	const payload = JSON.stringify({ system: { get_sysinfo: {} } })

	const encrypted = encryptKlapPayload({
		localSeed,
		remoteSeed,
		authHash,
		sequence,
		payload,
	})

	expect(encrypted.length).toBeGreaterThan(32)
	expect(
		decryptKlapPayload({
			localSeed,
			remoteSeed,
			authHash,
			sequence,
			payload: encrypted,
		}),
	).toBe(payload)
})

test('KLAP client authenticates and sends encrypted requests to a fake server', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials)
	const iv = deriveKlapIv({ localSeed, remoteSeed, authHash })
	const requests: Array<Record<string, unknown>> = []

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			expect(body).toEqual(localSeed)
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({
						localSeed,
						remoteSeed,
						authHash,
					}),
				]),
			)
			return
		}

		if (url.pathname === '/app/handshake2') {
			expect(request.headers.cookie).toContain('TP_SESSIONID=session-123')
			expect(body).toEqual(
				generateKlapHandshake2Hash({ localSeed, remoteSeed, authHash }),
			)
			response.end()
			return
		}

		if (url.pathname === '/app/request') {
			expect(request.headers.cookie).toContain('TP_SESSIONID=session-123')
			const sequence = Number(url.searchParams.get('seq'))
			expect(sequence).toBe(iv.sequence + 1)
			const decrypted = decryptKlapPayload({
				localSeed,
				remoteSeed,
				authHash,
				sequence,
				payload: body,
			})
			requests.push(JSON.parse(decrypted) as Record<string, unknown>)
			const responseBody = JSON.stringify({
				system: {
					get_sysinfo: {
						alias: 'Water recirculating pump',
						model: 'EP25',
						device_id: 'device-1',
						relay_state: 1,
					},
				},
			})
			response.end(
				encryptKlapPayload({
					localSeed,
					remoteSeed,
					authHash,
					sequence,
					payload: responseBody,
				}),
			)
			return
		}

		response.statusCode = 404
		response.end()
	})

	const port = await listen(server)
	const client = createKasaKlapClient({
		host: '127.0.0.1',
		port,
		credentials,
		localSeedFactory: () => localSeed,
	})

	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Water recirculating pump',
		model: 'EP25',
		relay_state: 1,
	})
	expect(requests).toEqual([{ system: { get_sysinfo: {} } }])
})

test('KLAP client resets the session after failed encrypted requests', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials)
	let handshakeCount = 0
	let requestCount = 0

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			handshakeCount += 1
			expect(body).toEqual(localSeed)
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({
						localSeed,
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
			requestCount += 1
			if (requestCount === 1) {
				response.statusCode = 500
				response.end('temporary failure')
				return
			}
			const sequence = Number(url.searchParams.get('seq'))
			response.end(
				encryptKlapPayload({
					localSeed,
					remoteSeed,
					authHash,
					sequence,
					payload: JSON.stringify({
						system: {
							get_sysinfo: {
								alias: 'Water recirculating pump',
								device_id: 'device-1',
								relay_state: 1,
							},
						},
					}),
				}),
			)
			return
		}

		response.statusCode = 404
		response.end()
	})

	const port = await listen(server)
	const client = createKasaKlapClient({
		host: '127.0.0.1',
		port,
		credentials,
		localSeedFactory: () => localSeed,
	})

	await expect(client.getSysInfo()).rejects.toThrow('responded with 500')
	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Water recirculating pump',
	})
	expect(handshakeCount).toBe(2)
})
