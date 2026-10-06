import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { type HomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { islandRouterApiCredentials } from '../../storage/schema.ts'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import {
	createIslandRouterApiAdapter,
	describeIslandRouterJsonShape,
	islandRouterApiWriteConfirmation,
} from './index.ts'
import { computeIslandRouterHotp } from './otp.ts'
import { saveIslandRouterApiPin } from './repository.ts'

type IslandRouterApiFetch = typeof fetch

function createConfig(
	dbPath: string,
	overrides: Partial<HomeConnectorConfig> = {},
): HomeConnectorConfig {
	return createTestHomeConnectorConfig({
		dataPath: path.dirname(dbPath),
		dbPath,
		mocksEnabled: true,
		accessNetworksUnleashedAllowInsecureTls: false,
		...overrides,
	})
}

function createJsonResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json',
		},
	})
}

test('encrypted PIN round-trips in sqlite and requires HOME_CONNECTOR_SHARED_SECRET', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-island-router-api-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(dbPath),
			storage,
			fetchImpl: async () => createJsonResponse({}),
		})
		expect(await adapter.getStatus()).toMatchObject({
			configured: false,
			hasStoredPin: false,
		})
		expect(await adapter.setPin(' 123456 ')).toMatchObject({
			configured: true,
			hasStoredPin: true,
		})
		const row = await storage.db.find(islandRouterApiCredentials, {
			connector_id: 'default',
		})
		expect(row?.pin).toMatch(/^enc:v1:/)
		expect(row?.pin).not.toContain('123456')
		await adapter.clearPin()
		expect(await adapter.getStatus()).toMatchObject({
			configured: false,
			hasStoredPin: false,
		})

		const missingSecretStorage = await createHomeConnectorStorage(
			createConfig(':memory:', { sharedSecret: null }),
		)
		try {
			await expect(
				saveIslandRouterApiPin({
					storage: missingSecretStorage,
					connectorId: 'default',
					pin: '123456',
				}),
			).rejects.toThrow('HOME_CONNECTOR_SHARED_SECRET')
		} finally {
			await missingSecretStorage.close()
		}
	} finally {
		await storage.close()
		rmSync(directory, { force: true, recursive: true })
	}
})

test('startup shape mismatch reports key names and value types only', async () => {
	const storage = await createHomeConnectorStorage(createConfig(':memory:'))
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const fetchImpl: IslandRouterApiFetch = async () =>
		createJsonResponse({
			data: {
				id: 'startup-id-with-secret-value',
				challenge: 'SUPER-SECRET-BASE32-VALUE',
				offset: 2,
				nested: { token: 'should-not-appear' },
			},
			meta: 'also-secret',
		})
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl,
		})
		await adapter.setPin('246810')
		let thrown: unknown
		try {
			await adapter.request({
				method: 'GET',
				path: '/api/filters',
			})
		} catch (error) {
			thrown = error
		}
		const message = thrown instanceof Error ? thrown.message : String(thrown)
		expect(message).toMatch(/startup response shape mismatch/)
		expect(message).toMatch(/expected data\.c as base32 secret string/)
		expect(message).toContain('"id":"string"')
		expect(message).toContain('"challenge":"string"')
		expect(message).toContain('"offset":"number"')
		expect(message).toContain('"nested":{"token":"string"}')
		expect(message).not.toContain('startup-id-with-secret-value')
		expect(message).not.toContain('SUPER-SECRET-BASE32-VALUE')
		expect(message).not.toContain('should-not-appear')
		expect(message).not.toContain('also-secret')
		expect(warn).toHaveBeenCalled()
		const status = await adapter.getStatus()
		expect(status.lastAuthError).toContain('shape mismatch')
		expect(status.lastAuthError).not.toContain('SUPER-SECRET-BASE32-VALUE')
	} finally {
		warn.mockRestore()
		await storage.close()
	}
})

test('describeIslandRouterJsonShape never includes primitive values', () => {
	expect(
		describeIslandRouterJsonShape({
			id: 'secret-id',
			c: 'GEZDGNBVGY3TQOJQ',
			d: 3,
			ok: true,
			missing: null,
			list: ['alpha', 1],
		}),
	).toEqual({
		id: 'string',
		c: 'string',
		d: 'number',
		ok: 'boolean',
		missing: 'null',
		list: {
			type: 'array',
			length: 2,
			sample: ['string', 'number'],
		},
	})
})

test('describeIslandRouterJsonShape redacts secret-like key names', () => {
	const secretAsKey = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBV'
	expect(
		describeIslandRouterJsonShape({
			data: {
				id: 'startup-id',
				[secretAsKey]: 'should-not-appear',
			},
		}),
	).toEqual({
		data: {
			id: 'string',
			[`[key:len=${String(secretAsKey.length)}]`]: 'string',
		},
	})
})

test('auth handshake sends startup, PIN OTP exchange, and bearer request', async () => {
	const storage = await createHomeConnectorStorage(createConfig(':memory:'))
	const requests: Array<{
		url: string
		init: RequestInit
		body: unknown
	}> = []
	const fetchImpl: IslandRouterApiFetch = async (url, init = {}) => {
		requests.push({
			url: String(url),
			init,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		})
		if (String(url).endsWith('/api/startup') && requests.length === 1) {
			return createJsonResponse({
				data: {
					id: 'startup-id',
					c: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
					d: 1,
				},
			})
		}
		if (String(url).endsWith('/api/startup') && requests.length === 2) {
			return createJsonResponse({
				data: {
					session: 'session-token',
					access: 'access-token',
					refresh: 'refresh-token',
				},
			})
		}
		return createJsonResponse({ filters: [] })
	}
	try {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-05T00:00:00.000Z'))
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl,
		})
		await adapter.setPin('246810')
		const result = await adapter.request({
			method: 'GET',
			path: '/api/filters',
		})
		expect(result).toMatchObject({
			method: 'GET',
			path: '/api/filters',
			status: 200,
			data: { filters: [] },
		})
		const timeBlocks = Math.floor(Date.now() / 1000 / 30)
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			'/api/startup',
			'/api/startup',
			'/api/filters',
		])
		expect(requests[0]?.body).toEqual({ timeBlocks })
		expect(requests[1]?.body).toEqual({
			id: 'startup-id',
			pin: '246810',
			otp: computeIslandRouterHotp({
				secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
				counter: timeBlocks + 1,
			}),
			timeBlocks,
		})
		expect(
			(requests[2]?.init.headers as Record<string, string>)?.authorization,
		).toBe('Bearer access-token')
	} finally {
		vi.useRealTimers()
		await storage.close()
	}
})

test('401 refreshes tokens and retries once, but a second 401 surfaces auth error', async () => {
	const storage = await createHomeConnectorStorage(createConfig(':memory:'))
	let filtersCalls = 0
	let refreshCalls = 0
	let startupCalls = 0
	const fetchImpl: IslandRouterApiFetch = async (url) => {
		const pathName = new URL(String(url)).pathname
		if (pathName === '/api/startup') {
			startupCalls += 1
			if (startupCalls % 2 === 1) {
				return createJsonResponse({
					data: {
						id: 'startup-id',
						c: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
						d: 0,
					},
				})
			}
			return createJsonResponse({
				data: {
					session: 'session-token',
					access: 'access-token',
					refresh: 'refresh-token',
				},
			})
		}
		if (pathName === '/api/refresh') {
			refreshCalls += 1
			return createJsonResponse({
				data: {
					session: 'session-token-2',
					access: 'access-token-2',
					refresh: 'refresh-token-2',
				},
			})
		}
		filtersCalls += 1
		return filtersCalls === 1
			? createJsonResponse({ error: 'expired' }, 401)
			: createJsonResponse({ filters: ['ok'] })
	}
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl,
		})
		await adapter.setPin('246810')
		await expect(
			adapter.request({
				method: 'GET',
				path: '/api/filters',
			}),
		).resolves.toMatchObject({
			status: 200,
			data: { filters: ['ok'] },
		})
		expect(startupCalls).toBe(2)
		expect(refreshCalls).toBe(1)
	} finally {
		await storage.close()
	}

	const failingStorage = await createHomeConnectorStorage(
		createConfig(':memory:'),
	)
	let failingFiltersCalls = 0
	let failingStartupCalls = 0
	const failingFetch: IslandRouterApiFetch = async (url) => {
		const pathName = new URL(String(url)).pathname
		if (pathName === '/api/startup') {
			failingStartupCalls += 1
			return failingStartupCalls % 2 === 1
				? createJsonResponse({
						data: {
							id: 'startup-id',
							c: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
							d: 0,
						},
					})
				: createJsonResponse({
						data: {
							session: 'session-token',
							access: 'access-token',
							refresh: 'refresh-token',
						},
					})
		}
		if (pathName === '/api/refresh') {
			return createJsonResponse({
				data: {
					session: 'session-token-2',
					access: 'access-token-2',
					refresh: 'refresh-token-2',
				},
			})
		}
		failingFiltersCalls += 1
		return createJsonResponse({ error: 'unauthorized' }, 401)
	}
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage: failingStorage,
			fetchImpl: failingFetch,
		})
		await adapter.setPin('246810')
		await expect(
			adapter.request({
				method: 'GET',
				path: '/api/filters',
			}),
		).rejects.toThrow('remained unauthorized')
		expect(failingFiltersCalls).toBe(2)
	} finally {
		failingStorage.close()
	}
})

test('request rejects invalid paths and high-risk writes without acknowledgement', async () => {
	const storage = await createHomeConnectorStorage(createConfig(':memory:'))
	try {
		const adapter = createIslandRouterApiAdapter({
			config: createConfig(':memory:'),
			storage,
			fetchImpl: async () => createJsonResponse({}),
		})
		await adapter.setPin('246810')
		await expect(
			adapter.request({ method: 'GET', path: '/filters' }),
		).rejects.toThrow('begin with /api/')
		await expect(
			adapter.request({ method: 'GET', path: '/api/filters\nbad' }),
		).rejects.toThrow('control characters')
		await expect(
			adapter.request({ method: 'GET', path: '/api/filters%0Abad' }),
		).rejects.toThrow('control characters')
		await expect(
			adapter.request({ method: 'GET', path: '/api/%2e%2e/filters' }),
		).rejects.toThrow('escape /api/')
		await expect(
			adapter.request({
				method: 'POST',
				path: '/api/filters',
				body: { name: 'Example' },
			}),
		).rejects.toThrow('acknowledgeHighRisk')
		await expect(
			adapter.request({
				method: 'POST',
				path: '/api/filters',
				body: { name: 'Example' },
				acknowledgeHighRisk: true,
				reason: 'too short',
				confirmation: islandRouterApiWriteConfirmation,
			}),
		).rejects.toThrow('reason must be at least 20 characters')
		await expect(
			adapter.request({
				method: 'POST',
				path: '/api/filters',
				body: { name: 'Example' },
				acknowledgeHighRisk: true,
				reason: 'Create an API filter for an explicitly requested policy.',
				confirmation: 'wrong',
			}),
		).rejects.toThrow('confirmation must exactly equal')
	} finally {
		await storage.close()
	}
})
