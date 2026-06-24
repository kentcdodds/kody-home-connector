import net from 'node:net'
import { afterEach, expect, test } from 'vitest'
import {
	createKasaLegacyClient,
	decodeKasaTcpResponse,
	encodeKasaTcpRequest,
} from './client.ts'

const servers: Array<net.Server> = []

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve())
				}),
		),
	)
	servers.length = 0
})

async function createFakeKasaServer(
	handler: (request: Record<string, unknown>) => Record<string, unknown>,
	options: {
		fragmentResponse?: boolean
		oversizedFrameLength?: number
	} = {},
) {
	const server = net.createServer((socket) => {
		const chunks: Array<Buffer> = []
		socket.on('data', (chunk) => {
			chunks.push(chunk)
			const frame = Buffer.concat(chunks)
			if (frame.length < 4) return
			const length = frame.readUInt32BE(0)
			if (frame.length < 4 + length) return
			const request = decodeKasaTcpResponse(frame)
			if (options.oversizedFrameLength) {
				const oversizedFrame = Buffer.alloc(4)
				oversizedFrame.writeUInt32BE(options.oversizedFrameLength, 0)
				socket.end(oversizedFrame)
				return
			}
			const response = encodeKasaTcpRequest(handler(request))
			if (options.fragmentResponse) {
				socket.write(response.subarray(0, 4))
				setImmediate(() => {
					socket.end(response.subarray(4))
				})
				return
			}
			socket.end(response)
		})
	})
	servers.push(server)
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve())
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Expected TCP server address object.')
	}
	return {
		host: address.address,
		port: address.port,
	}
}

test('Kasa TCP framing round-trips JSON payloads', () => {
	const payload = {
		system: {
			get_sysinfo: {},
		},
	}
	expect(decodeKasaTcpResponse(encodeKasaTcpRequest(payload))).toEqual(payload)
})

test('legacy client reads sysinfo and sets relay state', async () => {
	const requests: Array<Record<string, unknown>> = []
	const endpoint = await createFakeKasaServer((request) => {
		requests.push(request)
		const system = request['system'] as Record<string, unknown>
		if ('get_sysinfo' in system) {
			return {
				system: {
					get_sysinfo: {
						err_code: 0,
						alias: 'Office Lamp',
						model: 'HS103(US)',
						deviceId: '800612345678',
						relay_state: 1,
					},
				},
			}
		}
		return {
			system: {
				set_relay_state: {
					err_code: 0,
				},
			},
		}
	})
	const client = createKasaLegacyClient()

	await expect(client.getSysInfo(endpoint)).resolves.toMatchObject({
		alias: 'Office Lamp',
		relay_state: 1,
	})
	await expect(
		client.setRelayState({ ...endpoint, state: 0 }),
	).resolves.toMatchObject({
		err_code: 0,
	})
	expect(requests).toEqual([
		{
			system: {
				get_sysinfo: {},
			},
		},
		{
			system: {
				set_relay_state: {
					state: 0,
				},
			},
		},
	])
})

test('legacy client buffers fragmented TCP responses', async () => {
	const endpoint = await createFakeKasaServer(
		() => ({
			system: {
				get_sysinfo: {
					err_code: 0,
					alias: 'Fragmented Lamp',
					relay_state: 1,
				},
			},
		}),
		{ fragmentResponse: true },
	)
	const client = createKasaLegacyClient()

	await expect(client.getSysInfo(endpoint)).resolves.toMatchObject({
		alias: 'Fragmented Lamp',
		relay_state: 1,
	})
})

test('legacy client rejects oversized TCP response frames', async () => {
	const endpoint = await createFakeKasaServer(
		() => ({
			system: {
				get_sysinfo: {
					err_code: 0,
				},
			},
		}),
		{ oversizedFrameLength: 1024 * 1024 + 1 },
	)
	const client = createKasaLegacyClient()

	await expect(client.getSysInfo(endpoint)).rejects.toThrow(
		'Kasa response frame is too large',
	)
})
