import { type HomeConnectorConfig } from '../../config.ts'
import { fetchWithOptionalInsecureTls } from '../../http/fetch-with-insecure-tls.ts'
import {
	parseAraknisVlansPayload,
	parseOpenLldpNeighborsPayload,
} from './parsing.ts'
import {
	type AraknisSwitchClient,
	type AraknisSwitchLldpNeighbor,
	type AraknisSwitchVlan,
} from './types.ts'
import {
	assertAraknisSwitchConfigured,
	resolveAraknisSwitchBaseUrl,
} from './validation.ts'

type SessionState = {
	sidCookie: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function extractSidFromSetCookie(header: string | null): string | null {
	if (!header) return null
	const match =
		/(?:^|,\s*)(?:SIDSSL|SID)=([^;,\s]+)/i.exec(header) ??
		/(?:SIDSSL|SID)=([^;,\s]+)/i.exec(header)
	return match?.[1] ?? null
}

function extractSidFromPayload(payload: unknown): string | null {
	if (!isRecord(payload)) return null
	const sidssl = payload['SIDSSL'] ?? payload['sidssl']
	const sid = payload['SID'] ?? payload['sid']
	if (typeof sidssl === 'string' && sidssl.trim()) return sidssl.trim()
	if (typeof sid === 'string' && sid.trim()) return sid.trim()
	return null
}

export class AraknisSwitchRequestError extends Error {
	readonly statusCode: number | null
	readonly path: string

	constructor(
		message: string,
		input: { statusCode?: number | null; path: string; cause?: unknown },
	) {
		super(message, input.cause ? { cause: input.cause } : undefined)
		this.name = 'AraknisSwitchRequestError'
		this.statusCode = input.statusCode ?? null
		this.path = input.path
	}
}

export class AraknisSwitchAuthError extends AraknisSwitchRequestError {
	constructor(message: string, input: { path: string; cause?: unknown }) {
		super(message, { ...input, statusCode: 401 })
		this.name = 'AraknisSwitchAuthError'
	}
}

export function createAraknisSwitchOpenClient(input: {
	config: HomeConnectorConfig
	fetchImpl?: typeof fetch
}): AraknisSwitchClient {
	assertAraknisSwitchConfigured(input.config)
	const config = input.config
	const baseUrl = resolveAraknisSwitchBaseUrl(config)
	const username = config.araknisSwitchUsername!
	const password = config.araknisSwitchPassword!
	const session: SessionState = { sidCookie: null }

	async function rawFetch(path: string, init?: RequestInit) {
		const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
		const headers = new Headers(init?.headers)
		if (session.sidCookie) {
			headers.set('Cookie', session.sidCookie)
		}
		if (!headers.has('Accept')) {
			headers.set('Accept', 'application/json, text/plain, */*')
		}
		try {
			return await fetchWithOptionalInsecureTls({
				url,
				init: {
					...init,
					headers,
				},
				timeoutMs: config.araknisSwitchRequestTimeoutMs,
				allowInsecureTls: config.araknisSwitchAllowInsecureTls,
				fetchImpl: input.fetchImpl,
				stringBodyErrorMessage:
					'Araknis switch requests must use string bodies.',
			})
		} catch (error) {
			throw new AraknisSwitchRequestError(
				`Araknis switch request to ${path} failed.`,
				{ path, cause: error },
			)
		}
	}

	async function readJson(path: string, init?: RequestInit) {
		const response = await rawFetch(path, init)
		const text = await response.text()
		let payload: unknown = null
		if (text.trim().length > 0) {
			try {
				payload = JSON.parse(text)
			} catch {
				payload = { rawText: text.slice(0, 500) }
			}
		}
		return { response, payload, text }
	}

	async function ensureLogin() {
		if (session.sidCookie) return
		await login()
	}

	async function login() {
		const body = new URLSearchParams({
			username,
			password,
		}).toString()
		const { response, payload } = await readJson('/open/v1/login', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		})

		const setCookie =
			response.headers.getSetCookie?.().join(', ') ??
			response.headers.get('set-cookie')
		const sidValue =
			extractSidFromSetCookie(setCookie) ?? extractSidFromPayload(payload)
		if (!response.ok || !sidValue) {
			throw new AraknisSwitchAuthError(
				'Araknis switch login failed. Check ARAKNIS_SWITCH_USERNAME / ARAKNIS_SWITCH_PASSWORD and that HTTPS management is reachable from the connector host.',
				{ path: '/open/v1/login' },
			)
		}
		const cookieName = baseUrl.startsWith('https:') ? 'SIDSSL' : 'SID'
		session.sidCookie = `${cookieName}=${sidValue}`
	}

	async function logout() {
		if (!session.sidCookie) return
		try {
			await rawFetch('/open/v1/logout', { method: 'POST' })
		} finally {
			session.sidCookie = null
		}
	}

	async function getJson(path: string) {
		await ensureLogin()
		const first = await readJson(path, { method: 'GET' })
		if (first.response.status === 401 || first.response.status === 403) {
			session.sidCookie = null
			await ensureLogin()
			const retry = await readJson(path, { method: 'GET' })
			if (!retry.response.ok) {
				throw new AraknisSwitchRequestError(
					`Araknis switch GET ${path} failed with HTTP ${retry.response.status}.`,
					{ path, statusCode: retry.response.status },
				)
			}
			return retry.payload
		}
		if (!first.response.ok) {
			throw new AraknisSwitchRequestError(
				`Araknis switch GET ${path} failed with HTTP ${first.response.status}.`,
				{ path, statusCode: first.response.status },
			)
		}
		return first.payload
	}

	return {
		login,
		logout,
		async getDot1dBaseConfig() {
			const payload = await getJson('/open/v1/dot1dbaseconfig')
			return isRecord(payload) ? payload : {}
		},
		async listVlans() {
			const payload = await getJson('/open/v1/vlans?limit=512')
			return parseAraknisVlansPayload(payload)
		},
		async getVlan(vlanId: number) {
			const payload = await getJson(`/open/v1/vlans?id=${vlanId}`)
			const vlans = parseAraknisVlansPayload(payload)
			const vlan: AraknisSwitchVlan = vlans[0] ?? {
				id: vlanId,
				name: null,
				type: null,
			}
			const members = isRecord(payload)
				? Array.isArray(payload['interfaces'])
					? (payload['interfaces'] as Array<Record<string, unknown>>)
					: Array.isArray(payload['ports'])
						? (payload['ports'] as Array<Record<string, unknown>>)
						: Array.isArray(payload['vlanMembers'])
							? (payload['vlanMembers'] as Array<Record<string, unknown>>)
							: []
				: []
			return { vlan, members }
		},
		async listInterfaces() {
			const payload = await getJson('/open/v1/interfaces?limit=512')
			if (isRecord(payload) && Array.isArray(payload['interfaces'])) {
				return payload['interfaces'] as Array<Record<string, unknown>>
			}
			if (Array.isArray(payload)) {
				return payload as Array<Record<string, unknown>>
			}
			return []
		},
		async listLldpNeighbors(): Promise<Array<AraknisSwitchLldpNeighbor>> {
			const candidates = [
				'/open/v1/lldpremotedevices?limit=512',
				'/open/v1/lldpRemoteDevices?limit=512',
				'/open/v1/lldp/remotedevices?limit=512',
			]
			for (const path of candidates) {
				try {
					const payload = await getJson(path)
					const neighbors = parseOpenLldpNeighborsPayload(payload)
					if (neighbors.length > 0 || isRecord(payload)) {
						return neighbors
					}
				} catch (error) {
					if (
						error instanceof AraknisSwitchRequestError &&
						(error.statusCode === 404 || error.statusCode === 400)
					) {
						continue
					}
					throw error
				}
			}
			return []
		},
	}
}
