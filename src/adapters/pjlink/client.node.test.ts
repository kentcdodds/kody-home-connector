import net from 'node:net'
import { expect, test } from 'vitest'
import { createTcpPjlinkCommandClient, probePjlinkHandshake } from './client.ts'
import { computePjlinkAuthDigest } from './protocol.ts'

async function listenPjlink(handler: (socket: net.Socket) => void) {
	const server = net.createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve())
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Expected a TCP address')
	}
	return {
		host: '127.0.0.1',
		port: address.port,
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}

test('no-auth handshake then %1POWR query', async () => {
	const seen: Array<string> = []
	const listener = await listenPjlink((socket) => {
		socket.write('PJLINK 0\r')
		socket.on('data', (chunk) => {
			seen.push(chunk.toString('utf8'))
			socket.write('%1POWR=1\r')
		})
	})
	try {
		const handshake = await probePjlinkHandshake({
			host: listener.host,
			port: listener.port,
		})
		expect(handshake).toMatchObject({
			authRequired: false,
			raw: 'PJLINK 0',
		})
		const client = createTcpPjlinkCommandClient({ timeoutMs: 2_000 })
		const result = await client({
			host: listener.host,
			port: listener.port,
			command: 'POWR',
			parameter: '?',
		})
		expect(seen).toEqual(['%1POWR ?\r'])
		expect(result.handshake.authRequired).toBe(false)
		expect(result.value).toBe('1')
		expect(result.raw).toBe('%1POWR=1')
	} finally {
		await listener.close()
	}
})

test('authenticated handshake prefixes the command with the session digest', async () => {
	const seen: Array<string> = []
	const listener = await listenPjlink((socket) => {
		socket.write('PJLINK 1 a1b2c3d4\r')
		socket.on('data', (chunk) => {
			seen.push(chunk.toString('utf8'))
			socket.write('%1POWR=OK\r')
		})
	})
	try {
		const client = createTcpPjlinkCommandClient({ timeoutMs: 2_000 })
		const result = await client({
			host: listener.host,
			port: listener.port,
			password: 'secret',
			command: 'POWR',
			parameter: '0',
		})
		expect(seen).toEqual([
			`${computePjlinkAuthDigest({ random: 'a1b2c3d4', password: 'secret' })}%1POWR 0\r`,
		])
		expect(result.value).toBe('OK')
	} finally {
		await listener.close()
	}
})

test('unreachable hosts become PjlinkUnreachableError', async () => {
	const client = createTcpPjlinkCommandClient({ timeoutMs: 250 })
	await expect(
		client({
			host: '127.0.0.1',
			port: 1,
			command: 'POWR',
			parameter: '?',
		}),
	).rejects.toMatchObject({
		name: 'PjlinkUnreachableError',
	})
})
