import { createInterface } from 'node:readline'
import { createKasaKlapClient } from './klap-client.ts'
import { type KasaSysInfo } from './types.ts'

type KlapWorkerInput = {
	host: string
	port?: number
	username: string
	password: string
	timeoutMs?: number
	operation: 'getSysInfo' | 'setRelayState'
	state?: boolean
}

type KlapWorkerSuccess = {
	ok: true
	sysinfo?: KasaSysInfo
	response?: Record<string, unknown>
	authLabel: string | null
	usedConfiguredCredentials: boolean
}

type KlapWorkerFailure = {
	ok: false
	error: string
}

async function readWorkerInput() {
	const lines: Array<string> = []
	const rl = createInterface({ input: process.stdin })
	for await (const line of rl) {
		lines.push(line)
	}
	const raw = lines.join('\n').trim()
	if (!raw) throw new Error('Kasa KLAP worker received empty input.')
	return JSON.parse(raw) as KlapWorkerInput
}

async function main() {
	const input = await readWorkerInput()
	const client = createKasaKlapClient({
		host: input.host,
		port: input.port ?? 80,
		credentials: {
			username: input.username,
			password: input.password,
		},
		timeoutMs: input.timeoutMs ?? 8_000,
	})

	try {
		if (input.operation === 'getSysInfo') {
			const sysinfo = await client.getSysInfo()
			const result: KlapWorkerSuccess = {
				ok: true,
				sysinfo,
				authLabel: client.authLabel,
				usedConfiguredCredentials: client.usedConfiguredCredentials ?? false,
			}
			process.stdout.write(`${JSON.stringify(result)}\n`)
			return
		}

		if (input.operation === 'setRelayState') {
			if (typeof input.state !== 'boolean') {
				throw new Error('setRelayState requires a boolean state.')
			}
			const response = await client.setRelayState(input.state)
			const result: KlapWorkerSuccess = {
				ok: true,
				response,
				authLabel: client.authLabel,
				usedConfiguredCredentials: client.usedConfiguredCredentials ?? false,
			}
			process.stdout.write(`${JSON.stringify(result)}\n`)
			return
		}

		const _exhaustive: never = input.operation
		throw new Error(`Unsupported KLAP worker operation: ${String(_exhaustive)}`)
	} catch (error) {
		const result: KlapWorkerFailure = {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
		process.stdout.write(`${JSON.stringify(result)}\n`)
		process.exitCode = 1
	}
}

await main()
