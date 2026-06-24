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
	if (input.payload.method === 'get_device_info') {
		response.end(
			encryptKlapPayload({
				localSeed: input.localSeed,
				remoteSeed: input.remoteSeed,
				authHash: input.authHash,
				sequence: input.sequence,
				payload: JSON.stringify({
					error_code: 0,
					result: {
						nickname: Buffer.from('Water recirculating pump').toString(
							'base64',
						),
						model: 'EP25',
						device_id: 'device-1',
						device_on: true,
					},
				}),
			}),
		)
		return
	}

	response.end(
		encryptKlapPayload({
			localSeed: input.localSeed,
			remoteSeed: input.remoteSeed,
			authHash: input.authHash,
			sequence: input.sequence,
			payload: JSON.stringify({
				system: {
					get_sysinfo: {
						alias: 'Water recirculating pump',
						model: 'EP25',
						device_id: 'device-1',
						relay_state: 1,
					},
				},
			}),
		}),
	)
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

	const tampered = Buffer.from(encrypted)
	tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
	expect(() =>
		decryptKlapPayload({
			localSeed,
			remoteSeed,
			authHash,
			sequence,
			payload: tampered,
		}),
	).toThrow('signature')
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
			const payload = decryptKlapRequest(body, {
				localSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			requests.push(payload)
			respondToKlapSysinfoRequest(response, {
				localSeed,
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
	const client = createKasaKlapClient({
		host: '127.0.0.1',
		port,
		credentials,
		localSeedFactory: () => localSeed,
	})

	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Water recirculating pump',
		model: 'EP25',
		relay_state: true,
	})
	expect(requests).toEqual([
		expect.objectContaining({ method: 'get_device_info' }),
	])
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
			if (requestCount <= 2) {
				response.statusCode = 500
				response.end('temporary failure')
				return
			}
			const sequence = Number(url.searchParams.get('seq'))
			const payload = decryptKlapRequest(body, {
				localSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			respondToKlapSysinfoRequest(response, {
				localSeed,
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
	expect(handshakeCount).toBe(3)
})

test('KLAP client can match KLAP v2 handshake hashes', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials, 2)
	let handshake2Payload: Buffer | null = null

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({
						localSeed: body,
						remoteSeed,
						authHash,
						hashVersion: 2,
					}),
				]),
			)
			return
		}

		if (url.pathname === '/app/handshake2') {
			handshake2Payload = body
			response.end()
			return
		}

		if (url.pathname === '/app/request') {
			const sequence = Number(url.searchParams.get('seq'))
			const payload = decryptKlapRequest(body, {
				localSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			respondToKlapSysinfoRequest(response, {
				localSeed,
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
	const client = createKasaKlapClient({
		host: '127.0.0.1',
		port,
		credentials,
		localSeedFactory: () => localSeed,
	})

	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Water recirculating pump',
	})
	expect(handshake2Payload).toEqual(
		generateKlapHandshake2Hash({
			localSeed,
			remoteSeed,
			authHash,
			hashVersion: 2,
		}),
	)
	expect(client.usedConfiguredCredentials).toBe(true)
})

test('KLAP client falls back when smart get_device_info returns empty result', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials)
	const requests: Array<Record<string, unknown>> = []

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({ localSeed, remoteSeed, authHash }),
				]),
			)
			return
		}

		if (url.pathname === '/app/handshake2') {
			response.end()
			return
		}

		if (url.pathname === '/app/request') {
			const sequence = Number(url.searchParams.get('seq'))
			const payload = decryptKlapRequest(body, {
				localSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			requests.push(payload)
			if (payload.method === 'get_device_info') {
				response.end(
					encryptKlapPayload({
						localSeed,
						remoteSeed,
						authHash,
						sequence,
						payload: JSON.stringify({ error_code: 0, result: {} }),
					}),
				)
				return
			}
			respondToKlapSysinfoRequest(response, {
				localSeed,
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
	const client = createKasaKlapClient({
		host: '127.0.0.1',
		port,
		credentials,
		localSeedFactory: () => localSeed,
	})

	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Water recirculating pump',
		model: 'EP25',
	})
	expect(requests).toEqual([
		expect.objectContaining({ method: 'get_device_info' }),
		expect.objectContaining({ system: { get_sysinfo: {} } }),
	])
})

test('KLAP client falls back when smart get_device_info returns sparse result', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials)

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({ localSeed, remoteSeed, authHash }),
				]),
			)
			return
		}

		if (url.pathname === '/app/handshake2') {
			response.end()
			return
		}

		if (url.pathname === '/app/request') {
			const sequence = Number(url.searchParams.get('seq'))
			const payload = decryptKlapRequest(body, {
				localSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			if (payload.method === 'get_device_info') {
				response.end(
					encryptKlapPayload({
						localSeed,
						remoteSeed,
						authHash,
						sequence,
						payload: JSON.stringify({
							error_code: 0,
							result: { model: 'EP25', device_on: true },
						}),
					}),
				)
				return
			}
			respondToKlapSysinfoRequest(response, {
				localSeed,
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
	const client = createKasaKlapClient({
		host: '127.0.0.1',
		port,
		credentials,
		localSeedFactory: () => localSeed,
	})

	await expect(client.getSysInfo()).resolves.toMatchObject({
		alias: 'Water recirculating pump',
		model: 'EP25',
	})
})

test('KLAP client keeps plain-text smart nicknames when they are not base64', async () => {
	const credentials = {
		username: 'kent@example.com',
		password: 'secret-password',
	}
	const localSeed = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
	const remoteSeed = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
	const authHash = generateKlapAuthHash(credentials)

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const body = await readRequestBody(request)

		if (url.pathname === '/app/handshake1') {
			response.setHeader('set-cookie', [
				'TP_SESSIONID=session-123; Path=/app',
				'TIMEOUT=86400; Path=/app',
			])
			response.end(
				Buffer.concat([
					remoteSeed,
					generateKlapHandshake1Hash({ localSeed, remoteSeed, authHash }),
				]),
			)
			return
		}

		if (url.pathname === '/app/handshake2') {
			response.end()
			return
		}

		if (url.pathname === '/app/request') {
			const sequence = Number(url.searchParams.get('seq'))
			const payload = decryptKlapRequest(body, {
				localSeed,
				remoteSeed,
				authHash,
				sequence,
			})
			if (payload.method === 'get_device_info') {
				response.end(
					encryptKlapPayload({
						localSeed,
						remoteSeed,
						authHash,
						sequence,
						payload: JSON.stringify({
							error_code: 0,
							result: {
								nickname: 'Radon pumps',
								model: 'EP25',
								device_on: true,
							},
						}),
					}),
				)
				return
			}
			response.statusCode = 404
			response.end()
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
		alias: 'Radon pumps',
		model: 'EP25',
		relay_state: true,
	})
})
