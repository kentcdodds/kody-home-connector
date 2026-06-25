import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	type KasaClient,
	type KasaClientCredentials,
	type KasaSysInfo,
} from './types.ts'

type KlapSubprocessClientInput = {
	host: string
	port: number
	credentials: KasaClientCredentials
	timeoutMs: number
}

type KlapWorkerResult =
	| {
			ok: true
			sysinfo?: KasaSysInfo
			response?: Record<string, unknown>
			authLabel: string | null
			usedConfiguredCredentials: boolean
	  }
	| {
			ok: false
			error: string
	  }

const workerPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'klap-worker.ts',
)

function shouldUseKasaKlapSubprocess() {
	const value = process.env.KASA_KLAP_USE_SUBPROCESS?.trim().toLowerCase()
	if (value === 'false' || value === '0') return false
	return true
}

function runKlapWorker(input: {
	host: string
	port: number
	credentials: KasaClientCredentials
	timeoutMs: number
	operation: 'getSysInfo' | 'setRelayState'
	state?: boolean
}): Promise<KlapWorkerResult> {
	return new Promise((resolve, reject) => {
		let settled = false
		const settle = (callback: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			callback()
		}

		const child = spawn(
			process.execPath,
			['--import', './src/sentry-init.ts', workerPath],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					SENTRY_DSN: '',
				},
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		)

		const stdoutChunks: Array<Buffer> = []
		const stderrChunks: Array<Buffer> = []
		child.stdout.on('data', (chunk) => {
			stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		})
		child.stderr.on('data', (chunk) => {
			stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		})

		const workerTimeoutMs = input.timeoutMs + 5_000
		const timeout = setTimeout(() => {
			child.kill('SIGKILL')
			setTimeout(() => {
				settle(() => {
					reject(
						new Error(
							`Kasa KLAP subprocess timed out for ${input.host} after ${String(workerTimeoutMs)}ms.`,
						),
					)
				})
			}, 500)
		}, workerTimeoutMs)

		child.on('error', (error) => {
			settle(() => {
				reject(error)
			})
		})

		child.on('close', (code) => {
			settle(() => {
				const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
				const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
				if (!stdout) {
					reject(
						new Error(
							`Kasa KLAP subprocess for ${input.host} produced no output${stderr ? `: ${stderr}` : code != null ? ` (exit ${String(code)})` : ''}.`,
						),
					)
					return
				}
				try {
					const parsed = JSON.parse(stdout) as KlapWorkerResult
					resolve(parsed)
				} catch (error) {
					reject(
						new Error(
							`Kasa KLAP subprocess for ${input.host} returned invalid JSON${stderr ? `: ${stderr}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
						),
					)
				}
			})
		})

		child.stdin.end(
			JSON.stringify({
				host: input.host,
				port: input.port,
				username: input.credentials.username,
				password: input.credentials.password,
				timeoutMs: input.timeoutMs,
				operation: input.operation,
				state: input.state,
			}),
		)
	})
}

class KasaKlapSubprocessClient implements KasaClient {
	#host: string
	#port: number
	#credentials: KasaClientCredentials
	#timeoutMs: number
	#lastAuthLabel: string | null = null
	#lastUsedConfiguredCredentials = false

	constructor(input: KlapSubprocessClientInput) {
		this.#host = input.host
		this.#port = input.port
		this.#credentials = input.credentials
		this.#timeoutMs = input.timeoutMs
	}

	get authLabel() {
		return this.#lastAuthLabel
	}

	get usedConfiguredCredentials() {
		return this.#lastUsedConfiguredCredentials
	}

	async #runWorker(input: {
		operation: 'getSysInfo' | 'setRelayState'
		state?: boolean
	}) {
		const result = await runKlapWorker({
			host: this.#host,
			port: this.#port,
			credentials: this.#credentials,
			timeoutMs: this.#timeoutMs,
			operation: input.operation,
			state: input.state,
		})
		if (!result.ok) {
			throw new Error(result.error)
		}
		this.#lastAuthLabel = result.authLabel
		this.#lastUsedConfiguredCredentials = result.usedConfiguredCredentials
		return result
	}

	async getSysInfo() {
		const result = await this.#runWorker({ operation: 'getSysInfo' })
		if (!result.sysinfo || typeof result.sysinfo !== 'object') {
			throw new Error(
				`Kasa plug ${this.#host} did not return device info from KLAP subprocess.`,
			)
		}
		return result.sysinfo
	}

	async setRelayState(state: boolean) {
		const result = await this.#runWorker({
			operation: 'setRelayState',
			state,
		})
		return result.response ?? {}
	}
}

export function createKasaKlapSubprocessClient(
	input: KlapSubprocessClientInput,
) {
	return new KasaKlapSubprocessClient(input)
}

export function shouldUseKasaKlapSubprocessClient() {
	return shouldUseKasaKlapSubprocess()
}
