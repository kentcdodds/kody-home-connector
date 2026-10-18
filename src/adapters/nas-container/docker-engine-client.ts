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
	/** When true, drain a streaming JSON-lines / progress body. */
	stream?: boolean
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
			await jsonRequest('GET', '/_ping', undefined, [200])
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
			const response = await engineRequest({
				method: 'POST',
				path,
				stream: true,
			})
			if (response.statusCode !== 200) {
				throw new DockerEngineError(
					response.statusCode,
					response.body.toString('utf8'),
					path,
				)
			}
			// Docker streams NDJSON progress; surface the last error line if present.
			const text = response.body.toString('utf8')
			for (const line of text.split('\n')) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					const event = JSON.parse(trimmed) as { error?: string }
					if (event.error) {
						throw new Error(`Docker pull failed: ${event.error}`)
					}
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.startsWith('Docker pull')
					) {
						throw error
					}
				}
			}
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
