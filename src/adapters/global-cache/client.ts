import net from 'node:net'
import { type GlobalCacheCommandClient } from './types.ts'

const defaultTimeoutMs = 8_000

function isErrorLine(line: string) {
	return line.startsWith('ERR_')
}

export function createTcpGlobalCacheCommandClient(input: {
	host: string
	port: number
	timeoutMs?: number
}): GlobalCacheCommandClient {
	const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
	return async ({ command, isComplete }) => {
		return await new Promise<Array<string>>((resolve, reject) => {
			const socket = new net.Socket()
			let settled = false
			let buffer = ''
			const lines: Array<string> = []

			function finish(error: Error | null) {
				if (settled) return
				settled = true
				socket.removeAllListeners()
				socket.destroy()
				if (error) {
					reject(error)
					return
				}
				resolve(lines)
			}

			socket.setTimeout(timeoutMs)
			socket.once('timeout', () => {
				finish(
					new Error(
						`Global Cache command timed out after ${String(timeoutMs)}ms: ${command}`,
					),
				)
			})
			socket.once('error', (error) => {
				finish(error)
			})
			socket.on('data', (chunk) => {
				buffer += chunk.toString('latin1')
				while (buffer.includes('\r')) {
					const index = buffer.indexOf('\r')
					const line = buffer.slice(0, index).replaceAll('\n', '').trim()
					buffer = buffer.slice(index + 1)
					if (!line) continue
					lines.push(line)
					if (isErrorLine(line)) {
						finish(new Error(`Global Cache error: ${line}`))
						return
					}
					if (isComplete(line, lines)) {
						finish(null)
					}
				}
			})
			socket.connect(input.port, input.host, () => {
				socket.write(`${command}\r`)
			})
		})
	}
}
