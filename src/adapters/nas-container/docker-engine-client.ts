import http from 'node:http'
import { type IncomingMessage } from 'node:http'
import {
	type DockerContainerInspect,
	type DockerContainerSummary,
	type DockerImageInspect,
	type NasDockerEngineClient,
} from './types.ts'

export type DockerEngineRequest = {
	method: string
	path: string
	body?: unknown
}

export class DockerEngineError extends Error {
	readonly statusCode: number
	readonly responseBody: string

	constructor(statusCode: number, responseBody: string, path: string) {
		super(
			`Docker Engine API ${path} failed with HTTP ${String(statusCode)}: ${responseBody.slice(0, 500)}`,
		)
		this.name = 'DockerEngineError'
		this.statusCode = statusCode
		this.responseBody = responseBody
	}
}

function readIncomingMessage(response: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = []
		response.on('data', (chunk: Buffer | string) => {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
		})
		response.on('end', () => resolve(Buffer.concat(chunks)))
		response.on('error', reject)
	})
}

/**
 * Drain a Docker NDJSON progress stream without buffering the whole body.
 * Keeps only a bounded partial line while scanning for `error` events.
 */
function drainNdjsonProgress(
	response: IncomingMessage,
): Promise<{ statusCode: number }> {
	return new Promise((resolve, reject) => {
		let partial = ''
		let settled = false
		const fail = (error: Error) => {
			if (settled) return
			settled = true
			response.destroy()
			reject(error)
		}
		response.setEncoding('utf8')
		response.on('data', (chunk: string) => {
			partial += chunk
			if (partial.length > 64_000) {
				// Bound memory if a line never ends.
				partial = partial.slice(-8_000)
			}
			const lines = partial.split('\n')
			partial = lines.pop() ?? ''
			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					const event = JSON.parse(trimmed) as { error?: string }
					if (event.error) {
						fail(new Error(`Docker pull failed: ${event.error}`))
						return
					}
				} catch {
					// Ignore non-JSON progress noise.
				}
			}
		})
		response.on('end', () => {
			if (settled) return
			settled = true
			const trimmed = partial.trim()
			if (trimmed) {
				try {
					const event = JSON.parse(trimmed) as { error?: string }
					if (event.error) {
						reject(new Error(`Docker pull failed: ${event.error}`))
						return
					}
				} catch {
					// ignore trailing partial
				}
			}
			resolve({ statusCode: response.statusCode ?? 0 })
		})
		response.on('error', (error) => {
			if (!settled) {
				settled = true
				reject(error)
			}
		})
	})
}

export function createDockerEngineClient(input: {
	socketPath: string
	requestTimeoutMs?: number
	requestFn?: (
		options: http.RequestOptions,
		callback: (response: IncomingMessage) => void,
	) => http.ClientRequest
}): NasDockerEngineClient {
	const socketPath = input.socketPath
	const requestTimeoutMs = input.requestTimeoutMs ?? 120_000
	const requestFn = input.requestFn ?? http.request.bind(http)

	async function engineRequest(
		request: DockerEngineRequest,
	): Promise<{ statusCode: number; body: Buffer }> {
		const payload =
			request.body === undefined ? undefined : JSON.stringify(request.body)
		return await new Promise((resolve, reject) => {
			const req = requestFn(
				{
					socketPath,
					path: request.path,
					method: request.method,
					headers: {
						Host: 'localhost',
						Accept: 'application/json',
						...(payload
							? {
									'Content-Type': 'application/json',
									'Content-Length': Buffer.byteLength(payload),
								}
							: {}),
					},
					timeout: requestTimeoutMs,
				},
				(response) => {
					void readIncomingMessage(response)
						.then((body) => {
							resolve({
								statusCode: response.statusCode ?? 0,
								body,
							})
						})
						.catch(reject)
				},
			)
			req.on('timeout', () => {
				req.destroy(
					new Error(`Docker Engine request timed out: ${request.path}`),
				)
			})
			req.on('error', reject)
			if (payload) req.write(payload)
			req.end()
		})
	}

	async function jsonRequest<T>(
		method: string,
		path: string,
		body?: unknown,
		okStatuses: Array<number> = [200, 201, 204],
	): Promise<T> {
		const response = await engineRequest({ method, path, body })
		if (!okStatuses.includes(response.statusCode)) {
			throw new DockerEngineError(
				response.statusCode,
				response.body.toString('utf8'),
				path,
			)
		}
		if (response.statusCode === 204 || response.body.length === 0) {
			return undefined as T
		}
		return JSON.parse(response.body.toString('utf8')) as T
	}

	return {
		async ping() {
			// Docker Engine returns plain text "OK", not JSON.
			const response = await engineRequest({ method: 'GET', path: '/_ping' })
			if (response.statusCode !== 200) {
				throw new DockerEngineError(
					response.statusCode,
					response.body.toString('utf8'),
					'/_ping',
				)
			}
		},

		async inspectContainer(nameOrId) {
			return await jsonRequest<DockerContainerInspect>(
				'GET',
				`/containers/${encodeURIComponent(nameOrId)}/json`,
			)
		},

		async inspectImage(nameOrId) {
			return await jsonRequest<DockerImageInspect>(
				'GET',
				`/images/${encodeURIComponent(nameOrId)}/json`,
			)
		},

		async pullImage(repository, tag) {
			const path = `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`
			await new Promise<void>((resolve, reject) => {
				const req = requestFn(
					{
						socketPath,
						path,
						method: 'POST',
						headers: {
							Host: 'localhost',
							Accept: 'application/json',
						},
						timeout: requestTimeoutMs,
					},
					(response) => {
						const statusCode = response.statusCode ?? 0
						if (statusCode !== 200) {
							void readIncomingMessage(response)
								.then((body) => {
									reject(
										new DockerEngineError(
											statusCode,
											body.toString('utf8'),
											path,
										),
									)
								})
								.catch(reject)
							return
						}
						void drainNdjsonProgress(response)
							.then(() => resolve())
							.catch(reject)
					},
				)
				req.on('timeout', () => {
					req.destroy(new Error(`Docker Engine request timed out: ${path}`))
				})
				req.on('error', reject)
				req.end()
			})
		},

		async getDistributionDigest(imageRef) {
			try {
				const payload = await jsonRequest<{
					Descriptor?: { Digest?: string }
					Platforms?: Array<{ Descriptor?: { Digest?: string } }>
				}>('GET', `/distribution/${encodeURIComponent(imageRef)}/json`)
				return (
					payload.Descriptor?.Digest ??
					payload.Platforms?.[0]?.Descriptor?.Digest ??
					null
				)
			} catch (error) {
				if (error instanceof DockerEngineError && error.statusCode === 404) {
					return null
				}
				throw error
			}
		},

		async renameContainer(nameOrId, newName) {
			await jsonRequest(
				'POST',
				`/containers/${encodeURIComponent(nameOrId)}/rename?name=${encodeURIComponent(newName)}`,
				undefined,
				[204],
			)
		},

		async stopContainer(nameOrId, timeoutSeconds = 30) {
			try {
				await jsonRequest(
					'POST',
					`/containers/${encodeURIComponent(nameOrId)}/stop?t=${String(timeoutSeconds)}`,
					undefined,
					[204, 304],
				)
			} catch (error) {
				if (error instanceof DockerEngineError && error.statusCode === 304) {
					return
				}
				throw error
			}
		},

		async startContainer(nameOrId) {
			await jsonRequest(
				'POST',
				`/containers/${encodeURIComponent(nameOrId)}/start`,
				undefined,
				[204, 304],
			)
		},

		async removeContainer(nameOrId, options = {}) {
			const force = options.force === true ? '1' : '0'
			await jsonRequest(
				'DELETE',
				`/containers/${encodeURIComponent(nameOrId)}?force=${force}`,
				undefined,
				[204],
			)
		},

		async createContainer(input) {
			const created = await jsonRequest<{ Id?: string; id?: string }>(
				'POST',
				`/containers/create?name=${encodeURIComponent(input.name)}`,
				input.body,
				[201],
			)
			const id = created.Id ?? created.id
			if (!id) {
				throw new Error('Docker Engine createContainer response missing Id.')
			}
			return { id }
		},

		async listContainers(options = {}) {
			const params = new URLSearchParams()
			if (options.all) params.set('all', '1')
			if (options.filters) {
				params.set('filters', JSON.stringify(options.filters))
			}
			const query = params.toString()
			return await jsonRequest<Array<DockerContainerSummary>>(
				'GET',
				`/containers/json${query ? `?${query}` : ''}`,
			)
		},
	}
}
