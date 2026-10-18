import { type HomeConnectorConfig } from '../../config.ts'
import { fetchWithOptionalInsecureTls } from '../../http/fetch-with-insecure-tls.ts'
import {
	parseAraknisVlansPayload,
	parseOpenLldpNeighborsPayload,
} from './parsing.ts'
import {
	type AraknisSwitchClient,
	type AraknisSwitchCredentials,
	type AraknisSwitchLldpNeighbor,
} from './types.ts'
import {
	assertAraknisSwitchCredentialsPresent,
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
	credentials: AraknisSwitchCredentials
	fetchImpl?: typeof fetch
}): AraknisSwitchClient {
	const credentials = assertAraknisSwitchCredentialsPresent(input.credentials)
	const config = input.config
	const baseUrl = resolveAraknisSwitchBaseUrl(config)
	const username = credentials.username
	const password = credentials.password
	const session: SessionState = { sidCookie: null }
	let loginPromise: Promise<void> | null = null

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
				throw new AraknisSwitchRequestError(
					`Araknis switch ${path} returned non-JSON body (HTTP ${String(response.status)}).`,
					{ path, statusCode: response.status },
				)
			}
		}
		return { response, payload, text }
	}

	async function performLogin() {
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
			session.sidCookie = null
			throw new AraknisSwitchAuthError(
				'Araknis switch login failed. Check the credentials stored via /araknis-switch/setup (or araknis_set_credentials) and that HTTPS management is reachable from the connector host.',
				{ path: '/open/v1/login' },
			)
		}
		const cookieName = baseUrl.startsWith('https:') ? 'SIDSSL' : 'SID'
		session.sidCookie = `${cookieName}=${sidValue}`
	}

	async function ensureLogin() {
		if (session.sidCookie) return
		if (loginPromise) {
			await loginPromise
			return
		}
		loginPromise = performLogin().finally(() => {
			loginPromise = null
		})
		await loginPromise
	}

	async function login() {
		// Force a fresh session (used by araknis_authenticate).
		session.sidCookie = null
		loginPromise = null
		await ensureLogin()
	}

	async function logout() {
		if (!session.sidCookie) return
		try {
			await rawFetch('/open/v1/logout', { method: 'POST' })
		} finally {
			session.sidCookie = null
		}
	}

	function assertOpenPayloadOk(path: string, payload: unknown) {
		if (!isRecord(payload)) return
		const status = payload['status']
		if (!isRecord(status)) return
		const errorCode = status['error_code'] ?? status['errorCode']
		if (typeof errorCode === 'number' && errorCode !== 0) {
			const message =
				asString(status['msg'] ?? status['message'] ?? status['more_info']) ??
				`OpEN error_code=${String(errorCode)}`
			throw new AraknisSwitchRequestError(
				`Araknis switch GET ${path} returned OpEN error: ${message}.`,
				{ path, statusCode: asNumber(status['response_code']) },
			)
		}
	}

	function asString(value: unknown): string | null {
		if (typeof value !== 'string') return null
		const trimmed = value.trim()
		return trimmed.length > 0 ? trimmed : null
	}

	function asNumber(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.trunc(value)
		}
		if (typeof value === 'string' && value.trim()) {
			const parsed = Number(value)
			if (Number.isFinite(parsed)) return Math.trunc(parsed)
		}
		return null
	}

	async function getJson(path: string) {
		await ensureLogin()
		const first = await readJson(path, { method: 'GET' })
		if (first.response.status === 401 || first.response.status === 403) {
			session.sidCookie = null
			await ensureLogin()
			const retry = await readJson(path, { method: 'GET' })
			if (retry.response.status === 401 || retry.response.status === 403) {
				session.sidCookie = null
				throw new AraknisSwitchAuthError(
					`Araknis switch GET ${path} still unauthorized after re-login (HTTP ${String(retry.response.status)}).`,
					{ path },
				)
			}
			if (!retry.response.ok) {
				throw new AraknisSwitchRequestError(
					`Araknis switch GET ${path} failed with HTTP ${retry.response.status}.`,
					{ path, statusCode: retry.response.status },
				)
			}
			assertOpenPayloadOk(path, retry.payload)
			return retry.payload
		}
		if (!first.response.ok) {
			throw new AraknisSwitchRequestError(
				`Araknis switch GET ${path} failed with HTTP ${first.response.status}.`,
				{ path, statusCode: first.response.status },
			)
		}
		assertOpenPayloadOk(path, first.payload)
		return first.payload
	}

	function assertInventoryCollection(
		path: string,
		payload: unknown,
		keys: Array<string>,
	): Array<Record<string, unknown>> {
		if (Array.isArray(payload)) {
			return payload as Array<Record<string, unknown>>
		}
		if (!isRecord(payload)) {
			throw new AraknisSwitchRequestError(
				`Araknis switch GET ${path} returned an unrecognized payload shape.`,
				{ path, statusCode: 200 },
			)
		}
		for (const key of keys) {
			const value = payload[key]
			if (Array.isArray(value)) {
				return value as Array<Record<string, unknown>>
			}
		}
		// Valid empty inventory: OpEN often returns { status, <collection>: [] }
		// or just status with no collection key. Prefer empty over inventing rows,
		// but reject HTML/login masquerades already handled by readJson.
		if ('status' in payload || keys.some((key) => key in payload)) {
			return []
		}
		throw new AraknisSwitchRequestError(
			`Araknis switch GET ${path} returned an unrecognized inventory payload.`,
			{ path, statusCode: 200 },
		)
	}

	function isMeaningfulPoeGlobal(
		path: string,
		payload: Record<string, unknown>,
	): Record<string, unknown> | null {
		const nested = isRecord(payload['poeGlobal'])
			? payload['poeGlobal']
			: isRecord(payload['global'])
				? payload['global']
				: path.toLowerCase().includes('poeglobal')
					? payload
					: null
		if (!nested) return null
		const keys = Object.keys(nested).filter((key) => key !== 'status')
		return keys.length > 0 ? nested : null
	}

	async function getRecord(path: string) {
		const payload = await getJson(path)
		return isRecord(payload) ? payload : {}
	}

	return {
		login,
		logout,
		async getDot1dBaseConfig() {
			return getRecord('/open/v1/dot1dbaseconfig')
		},
		async getSystem1213() {
			return getRecord('/open/v1/system1213')
		},
		async getSystemMisc() {
			return getRecord('/open/v1/systemmisc')
		},
		async getRegistry() {
			return getRecord('/open/v1/registry')
		},
		async listVlans() {
			const path = '/open/v1/vlans?limit=512'
			const payload = await getJson(path)
			assertInventoryCollection(path, payload, ['vlans', 'vlan_element'])
			return parseAraknisVlansPayload(payload)
		},
		async getVlan(vlanId: number) {
			const payload = await getJson(`/open/v1/vlans?id=${vlanId}`)
			const vlans = parseAraknisVlansPayload(payload)
			const vlan = vlans.find((entry) => entry.id === vlanId) ?? null
			if (!vlan) {
				throw new AraknisSwitchRequestError(
					`Araknis switch VLAN ${String(vlanId)} was not found.`,
					{ path: `/open/v1/vlans?id=${vlanId}`, statusCode: 404 },
				)
			}
			const members = isRecord(payload)
				? Array.isArray(payload['interfaces'])
					? (payload['interfaces'] as Array<Record<string, unknown>>)
					: Array.isArray(payload['ports'])
						? (payload['ports'] as Array<Record<string, unknown>>)
						: Array.isArray(payload['vlanMembers'])
							? (payload['vlanMembers'] as Array<Record<string, unknown>>)
							: Array.isArray(payload['port_element'])
								? (payload['port_element'] as Array<Record<string, unknown>>)
								: []
				: []
			return { vlan, members }
		},
		async listInterfaces() {
			const path = '/open/v1/interfaces?limit=512'
			const payload = await getJson(path)
			return assertInventoryCollection(path, payload, [
				'interfaces',
				'port_element',
			])
		},
		async listPoe() {
			// Dell OpEN 6.8.0 does not document PoE resources. Probe common
			// FASTPATH-style names; treat 404/400 as "try next".
			const candidates = [
				'/open/v1/poeinterfaces?limit=512',
				'/open/v1/poeInterfaces?limit=512',
				'/open/v1/poe/interfaces?limit=512',
				'/open/v1/poe?limit=512',
				'/open/v1/poeglobal',
				'/open/v1/poeGlobal',
			]
			for (const path of candidates) {
				try {
					const payload = await getJson(path)
					if (!isRecord(payload) && !Array.isArray(payload)) continue
					const ports = isRecord(payload)
						? Array.isArray(payload['poeInterfaces'])
							? (payload['poeInterfaces'] as Array<Record<string, unknown>>)
							: Array.isArray(payload['poeinterfaces'])
								? (payload['poeinterfaces'] as Array<Record<string, unknown>>)
								: Array.isArray(payload['interfaces'])
									? (payload['interfaces'] as Array<Record<string, unknown>>)
									: Array.isArray(payload['ports'])
										? (payload['ports'] as Array<Record<string, unknown>>)
										: Array.isArray(payload['port_element'])
											? (payload['port_element'] as Array<
													Record<string, unknown>
												>)
											: []
						: (payload as Array<Record<string, unknown>>)
					const global = isRecord(payload)
						? isMeaningfulPoeGlobal(path, payload)
						: null
					if (ports.length > 0 || global) {
						return { ports, global, path }
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
			return { ports: [], global: null, path: null }
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
