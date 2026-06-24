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
			socket.end(encodeKasaTcpRequest(handler(request)))
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
