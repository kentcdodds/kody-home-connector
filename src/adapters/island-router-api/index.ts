import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { fetchIslandRouterApi } from './http.ts'
import { computeIsland323Hotp, computeIslandRouterHotp } from './otp.ts'
import {
	clearIslandRouterApiPin,
	getIslandRouterApiAuthStatus,
	getIslandRouterApiPin,
	hasIslandRouterApiStoredPin,
	saveIslandRouterApiPin,
	updateIslandRouterApiAuthStatus,
} from './repository.ts'
import {
	type IslandRouterApiAuthTokens,
	type IslandRouterApiMethod,
	type IslandRouterApiRequestInput,
	type IslandRouterApiRequestResult,
} from './types.ts'

export const islandRouterApiWriteConfirmation =
	'I understand this Island Router API request may change live router behavior.'

type WriteOperationRequest = {
	acknowledgeHighRisk?: boolean
	reason?: string
	confirmation?: string
}

type IslandRouterApiRequestWithRisk = IslandRouterApiRequestInput &
	WriteOperationRequest

const supportedMethods = new Set<IslandRouterApiMethod>([
	'GET',
	'POST',
	'PUT',
	'DELETE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Describe a JSON value's structure for diagnostics without exposing secrets.
 * Returns key names and value types only — never string/number/boolean values.
 * Key names that look like secret material (long / high-entropy) are replaced
 * with a length marker so a secret-as-key cannot leak into logs or lastAuthError.
 */
export function describeIslandRouterJsonShape(
	value: unknown,
	depth = 0,
): unknown {
	if (depth > 5) return 'max-depth'
	if (value === null) return 'null'
	if (Array.isArray(value)) {
		return {
			type: 'array',
			length: value.length,
			sample: value
				.slice(0, 3)
				.map((entry) => describeIslandRouterJsonShape(entry, depth + 1)),
		}
	}
	const valueType = typeof value
	if (valueType === 'object') {
		const shape: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		).slice(0, 40)) {
			shape[sanitizeIslandStartupShapeKey(key)] = describeIslandRouterJsonShape(
				entry,
				depth + 1,
			)
		}
		return shape
	}
	return valueType
}

function sanitizeIslandStartupShapeKey(key: string) {
	// Keep short identifier-style keys (id, c, d, challenge, data, …).
	// Longer keys are treated as possible secret-as-key material.
	if (key.length <= 24 && /^[A-Za-z_][\w.-]*$/.test(key)) {
		return key
	}
	return `[key:len=${String(key.length)}]`
}

function startupShapeMismatchError(payload: unknown, detail: string) {
	const shape = describeIslandRouterJsonShape(payload)
	const shapeJson = JSON.stringify(shape)
	console.warn(
		`Island Router startup response shape mismatch (${detail}). Observed keys/types only: ${shapeJson}`,
	)
	return new Error(
		`Island Router startup response shape mismatch (${detail}). Observed keys/types only: ${shapeJson}`,
	)
}

const islandRouterJwtLikePattern =
	/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g
const islandRouterOpaqueTokenPattern = /[A-Za-z0-9_-]{24,}/g
const islandRouterDiagnosticKeyPattern =
	/^(error|message|detail|code|reason|status|statusCode|status_code)$/i

/**
 * Truncated, secret-safe summary of an Island HTTP error body for thrown
 * errors. Only allowlisted diagnostic fields are echoed; JWTs / opaque tokens
 * are redacted; everything else is shape-only.
 */
export function formatIslandRouterHttpErrorBody(
	payload: unknown,
	maxLength = 240,
): string {
	if (payload == null || payload === '') return ''

	const parts: Array<string> = []
	if (typeof payload === 'string') {
		const diagnostic = redactIslandRouterErrorText(payload)
		if (diagnostic) parts.push(diagnostic)
	} else if (typeof payload === 'object') {
		const diagnostics = collectIslandRouterDiagnosticFields(payload)
		if (diagnostics && Object.keys(diagnostics).length > 0) {
			parts.push(JSON.stringify(diagnostics))
		}
		parts.push(
			`shape=${JSON.stringify(describeIslandRouterJsonShape(payload))}`,
		)
	} else {
		parts.push(
			`shape=${JSON.stringify(describeIslandRouterJsonShape(payload))}`,
		)
	}

	const text = parts.join(' ').replaceAll(/\s+/g, ' ').trim()
	if (!text) return ''
	if (text.length <= maxLength) return text
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function redactIslandRouterErrorText(text: string) {
	const redacted = text
		.replaceAll(islandRouterJwtLikePattern, '[redacted-jwt]')
		.replaceAll(islandRouterOpaqueTokenPattern, '[redacted]')
		// Avoid echoing PIN-sized digit runs that a router may include in text.
		.replaceAll(/\b\d{4,8}\b/g, '[redacted-digits]')
		.replaceAll(/\s+/g, ' ')
		.trim()
	if (!redacted) return ''
	const withoutMarkers = redacted
		.replaceAll(/\[redacted(?:-jwt|-digits)?\]/gi, '')
		.replaceAll(/[\s.,;:]/g, '')
	if (!withoutMarkers) return ''
	return redacted.length > 120 ? `${redacted.slice(0, 119)}…` : redacted
}

function collectIslandRouterDiagnosticFields(
	value: unknown,
	depth = 0,
): Record<string, unknown> | null {
	if (
		depth > 3 ||
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value)
	) {
		return null
	}
	const result: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(
		value as Record<string, unknown>,
	).slice(0, 30)) {
		if (islandRouterDiagnosticKeyPattern.test(key)) {
			if (typeof entry === 'string') {
				const redacted = redactIslandRouterErrorText(entry)
				if (redacted) result[key] = redacted
			} else if (
				typeof entry === 'number' ||
				typeof entry === 'boolean' ||
				entry === null
			) {
				result[key] = entry
			}
			continue
		}
		if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
			const nested = collectIslandRouterDiagnosticFields(entry, depth + 1)
			if (nested && Object.keys(nested).length > 0) {
				result[sanitizeIslandStartupShapeKey(key)] = nested
			}
		}
	}
	return result
}

function islandRouterHttpFailureMessage(
	status: number,
	payload: unknown,
	prefix = 'Island Router API request failed',
) {
	const body = formatIslandRouterHttpErrorBody(payload)
	return body
		? `${prefix} with HTTP ${String(status)}. Body: ${body}`
		: `${prefix} with HTTP ${String(status)}.`
}

function assertWriteAllowed(request: WriteOperationRequest) {
	if (!request.acknowledgeHighRisk) {
		throw new Error(
			'acknowledgeHighRisk must be true for non-GET Island Router API requests.',
		)
	}
	const reason = request.reason?.trim() ?? ''
	if (reason.length < 20) {
		throw new Error('reason must be at least 20 characters.')
	}
	if (request.confirmation !== islandRouterApiWriteConfirmation) {
		throw new Error(
			`confirmation must exactly equal: ${islandRouterApiWriteConfirmation}`,
		)
	}
}

export function validateIslandRouterApiPath(path: string) {
	if (!path) {
		throw new Error('Island Router API path must not be empty.')
	}
	let parsedPath = path
	try {
		parsedPath = decodeURIComponent(path)
	} catch {
		throw new Error('Island Router API path must be URI-decodable.')
	}
	if (
		[...parsedPath].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0
			return codePoint <= 0x1f || codePoint === 0x7f
		})
	) {
		throw new Error(
			'Island Router API path must not contain control characters.',
		)
	}
	if (!path.startsWith('/')) {
		throw new Error('Island Router API path must start with /.')
	}
	if (path.startsWith('//')) {
		throw new Error('Island Router API path must start with a single slash.')
	}
	if (!path.startsWith('/api/')) {
		throw new Error('Island Router API path must begin with /api/.')
	}
	if (
		parsedPath.includes('/../') ||
		parsedPath.endsWith('/..') ||
		parsedPath.includes('/./')
	) {
		throw new Error('Island Router API path must not escape /api/.')
	}
	return path
}

function normalizeMethod(method: string) {
	const normalized = method.toUpperCase()
	if (!supportedMethods.has(normalized as IslandRouterApiMethod)) {
		throw new Error(
			'Island Router API method must be GET, POST, PUT, or DELETE.',
		)
	}
	return normalized as IslandRouterApiMethod
}

function buildUrl(
	baseUrl: string,
	path: string,
	query?: Record<string, unknown>,
) {
	const url = new URL(path, `${baseUrl}/`)
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value == null) continue
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (entry == null) continue
				url.searchParams.append(key, String(entry))
			}
			continue
		}
		url.searchParams.set(key, String(value))
	}
	return url.toString()
}

async function parseJsonResponse(response: Response) {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return text
	}
}

type IslandStartupChallenge =
	| {
			kind: 'classic'
			id: string | number
			secret: string
			offset: number
	  }
	| {
			/**
			 * Island Pro 3.2.3 challenge from POST /api/startup after GET
			 * /api/startup/info. HOTP key = UTF-8(base32(token code-unit bytes));
			 * counter uses offset in 30-second blocks added before dividing.
			 * Never log token values.
			 */
			kind: 'token-offset'
			id: string | number
			token: string
			offset: number
			type: number | string
	  }

/**
 * Island 3.2.3 Flutter startup type enum (`B.acd` / `DY`):
 * 0 init, 1 reset, 2 unused (also parse-failure fallback), 3 base (normal).
 * Only base is implemented.
 */
const ISLAND_323_STARTUP_TYPE = {
	init: 0,
	reset: 1,
	unused: 2,
	base: 3,
} as const

function normalizeIsland323StartupType(type: number | string): number | null {
	if (typeof type === 'number' && Number.isInteger(type)) return type
	if (typeof type === 'string' && /^-?\d+$/.test(type.trim())) {
		return Number(type.trim())
	}
	return null
}

function island323UnsupportedStartupTypeError(type: number | string) {
	const normalized = normalizeIsland323StartupType(type)
	switch (normalized) {
		case ISLAND_323_STARTUP_TYPE.init:
			return new Error(
				'Island Router 3.2.3 startup type is init: router needs first-device setup in the Island app.',
			)
		case ISLAND_323_STARTUP_TYPE.reset:
			return new Error(
				'Island Router 3.2.3 startup type is reset: PIN was reset, set a new PIN in the Island app.',
			)
		case ISLAND_323_STARTUP_TYPE.unused:
			return new Error(
				'Island Router 3.2.3 startup type is unused: unrecognized startup response.',
			)
		case ISLAND_323_STARTUP_TYPE.base:
			// Caller only invokes this for non-base types; keep the message safe.
			return new Error(
				'Island Router 3.2.3 startup type is unrecognized startup response.',
			)
		case null:
			return new Error(
				'Island Router 3.2.3 startup type is unrecognized startup response.',
			)
		default:
			// Do not echo arbitrary router type text into lastAuthError.
			return new Error(
				'Island Router 3.2.3 startup type is unrecognized startup response.',
			)
	}
}

function getStartupData(payload: unknown): IslandStartupChallenge {
	const data = isRecord(payload) ? payload['data'] : null
	if (!isRecord(data)) {
		throw startupShapeMismatchError(
			payload,
			'expected a data object with classic id/c/d or 3.2.3 id/token/offset/type',
		)
	}
	const id = data['id']
	if (typeof id !== 'string' && typeof id !== 'number') {
		throw startupShapeMismatchError(
			payload,
			'expected data.id as string or number',
		)
	}

	const classicSecret = data['c']
	const classicOffset = data['d']
	const hasClassic =
		typeof classicSecret === 'string' && typeof classicOffset === 'number'
	if (hasClassic) {
		return {
			kind: 'classic',
			id,
			secret: classicSecret,
			offset: classicOffset,
		}
	}

	const token = data['token']
	const offset = data['offset']
	const type = data['type']
	const hasTokenOffset =
		typeof token === 'string' &&
		token.length > 0 &&
		typeof offset === 'number' &&
		Number.isFinite(offset) &&
		(typeof type === 'number' || typeof type === 'string')
	if (hasTokenOffset) {
		return {
			kind: 'token-offset',
			id,
			token,
			offset,
			type,
		}
	}

	throw startupShapeMismatchError(
		payload,
		'expected classic data.c (base32) + data.d (number), or 3.2.3 data.token (string) + data.offset (number) + data.type',
	)
}

function computeStartupOtp(input: {
	challenge: IslandStartupChallenge
	timeBlocks: number
	nowMs: number
}) {
	const { challenge, timeBlocks, nowMs } = input
	switch (challenge.kind) {
		case 'classic':
			return computeIslandRouterHotp({
				secret: challenge.secret,
				counter: timeBlocks + challenge.offset,
			})
		case 'token-offset':
			return computeIsland323Hotp({
				token: challenge.token,
				nowMs,
				offset: challenge.offset,
			})
		default: {
			const _exhaustive: never = challenge
			return _exhaustive
		}
	}
}

function getTokenData(payload: unknown): IslandRouterApiAuthTokens {
	const data = isRecord(payload) ? payload['data'] : null
	if (!isRecord(data)) {
		throw new Error(
			'Island Router authentication response did not include data.',
		)
	}
	const session = data['session']
	const access = data['access']
	const refresh = data['refresh']
	if (
		typeof session !== 'string' ||
		typeof access !== 'string' ||
		typeof refresh !== 'string'
	) {
		throw new Error(
			'Island Router authentication response did not include JWTs.',
		)
	}
	return { session, access, refresh }
}

async function requestJson(input: {
	fetchImpl: typeof fetch
	config: HomeConnectorConfig
	path: string
	method: IslandRouterApiMethod
	body?: unknown
	token?: string
	timeoutMs?: number
}) {
	const headers: Record<string, string> = {
		accept: 'application/json',
	}
	let body: string | undefined
	if (input.body !== undefined) {
		headers['content-type'] = 'application/json'
		body = JSON.stringify(input.body)
	}
	if (input.token) {
		// Island Flutter app sends the bare access token (no "Bearer " prefix).
		headers.authorization = input.token
	}
	return await fetchIslandRouterApi({
		url: buildUrl(input.config.islandRouterApiBaseUrl, input.path),
		init: {
			method: input.method,
			headers,
			body,
		},
		timeoutMs: input.timeoutMs ?? input.config.islandRouterApiRequestTimeoutMs,
		allowInsecureTls: input.config.islandRouterApiAllowInsecureTls,
		fetchImpl: input.fetchImpl,
	})
}

export function createIslandRouterApiAdapter(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
	fetchImpl?: typeof fetch
}) {
	const { config, storage } = input
	const connectorId = config.homeConnectorId
	const fetchImpl = input.fetchImpl ?? globalThis.fetch
	let tokens: IslandRouterApiAuthTokens | null = null

	async function requirePin() {
		if (!storage.sharedSecret) {
			throw new Error(
				'Island Router API requests require HOME_CONNECTOR_SHARED_SECRET.',
			)
		}
		const pin = await getIslandRouterApiPin(storage, connectorId)
		if (!pin) {
			throw new Error(
				'Island Router API PIN is not configured. Run island_router_api_set_pin first.',
			)
		}
		return pin
	}

	async function authenticate() {
		const pin = await requirePin()
		const nowMs = Date.now()
		const timeBlocks = Math.floor(nowMs / 1000 / 30)
		try {
			// Island 3.2.3 discovers via GET /api/startup/info before the
			// challenge POST. Older firmware without that route keeps the
			// classic id/c/d handshake unchanged.
			const infoResponse = await requestJson({
				fetchImpl,
				config,
				path: '/api/startup/info',
				method: 'GET',
			})
			const useFirmware323 = infoResponse.ok
			// Drain/cancel so the discovery response does not hold the socket
			// open until GC while we continue the challenge POST.
			await infoResponse.body?.cancel().catch(() => {})

			const startupResponse = await requestJson({
				fetchImpl,
				config,
				path: '/api/startup',
				method: 'POST',
				body: useFirmware323
					? { timeBlocks: String(timeBlocks) }
					: { timeBlocks },
			})
			const startupPayload = await parseJsonResponse(startupResponse)
			if (!startupResponse.ok) {
				throw new Error(
					`Island Router startup failed with HTTP ${startupResponse.status}.`,
				)
			}
			const startup = getStartupData(startupPayload)

			if (startup.kind === 'token-offset') {
				const startupType = normalizeIsland323StartupType(startup.type)
				if (startupType !== ISLAND_323_STARTUP_TYPE.base) {
					throw island323UnsupportedStartupTypeError(startup.type)
				}
			}

			const otp = computeStartupOtp({
				challenge: startup,
				timeBlocks,
				nowMs,
			})

			const authBody =
				startup.kind === 'classic'
					? {
							id: startup.id,
							pin,
							otp,
							timeBlocks,
						}
					: {
							id: String(startup.id),
							pin: String(pin),
							otp,
						}

			const authResponse = await requestJson({
				fetchImpl,
				config,
				path: '/api/startup',
				method: 'POST',
				body: authBody,
			})
			const authPayload = await parseJsonResponse(authResponse)
			if (!authResponse.ok) {
				if (startup.kind === 'token-offset') {
					throw new Error(
						`Island Router 3.2.3 authentication failed with HTTP ${String(authResponse.status)} after GET /api/startup/info and utf8(base32(token)) HOTP (token, PIN, and otp values not logged).`,
					)
				}
				throw new Error(
					`Island Router authentication failed with HTTP ${authResponse.status}.`,
				)
			}
			tokens = getTokenData(authPayload)
			await updateIslandRouterApiAuthStatus({
				storage,
				connectorId,
				lastAuthenticatedAt: new Date().toISOString(),
				lastAuthError: null,
			})
			return tokens
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await updateIslandRouterApiAuthStatus({
				storage,
				connectorId,
				lastAuthenticatedAt:
					(await getIslandRouterApiAuthStatus(storage, connectorId))
						?.lastAuthenticatedAt ?? null,
				lastAuthError: message,
			})
			throw error
		}
	}

	async function refresh() {
		if (!tokens) return await authenticate()
		const response = await requestJson({
			fetchImpl,
			config,
			path: '/api/refresh',
			method: 'POST',
			body: tokens,
			timeoutMs: config.islandRouterApiRequestTimeoutMs,
		})
		const payload = await parseJsonResponse(response)
		if (!response.ok) {
			tokens = null
			await updateIslandRouterApiAuthStatus({
				storage,
				connectorId,
				lastAuthenticatedAt:
					(await getIslandRouterApiAuthStatus(storage, connectorId))
						?.lastAuthenticatedAt ?? null,
				lastAuthError: `Island Router token refresh failed with HTTP ${response.status}.`,
			})
			return await authenticate()
		}
		tokens = getTokenData(payload)
		await updateIslandRouterApiAuthStatus({
			storage,
			connectorId,
			lastAuthenticatedAt: new Date().toISOString(),
			lastAuthError: null,
		})
		return tokens
	}

	async function request(
		requestInput: IslandRouterApiRequestWithRisk,
	): Promise<IslandRouterApiRequestResult> {
		const method = normalizeMethod(requestInput.method)
		if (method !== 'GET') {
			assertWriteAllowed(requestInput)
		}
		const path = validateIslandRouterApiPath(requestInput.path)
		const timeoutMs =
			requestInput.timeoutMs == null
				? config.islandRouterApiRequestTimeoutMs
				: Math.max(1000, requestInput.timeoutMs)
		const authTokens = tokens ?? (await authenticate())
		const url = buildUrl(
			config.islandRouterApiBaseUrl,
			path,
			requestInput.query,
		)
		const init: RequestInit = {
			method,
			headers: {
				accept: 'application/json',
				// Island Flutter app: bare access token, no "Bearer " prefix.
				authorization: authTokens.access,
				...(requestInput.body === undefined
					? {}
					: { 'content-type': 'application/json' }),
			},
			...(requestInput.body === undefined
				? {}
				: { body: JSON.stringify(requestInput.body) }),
		}
		let response = await fetchIslandRouterApi({
			url,
			init,
			timeoutMs,
			allowInsecureTls: config.islandRouterApiAllowInsecureTls,
			fetchImpl,
		})
		if (response.status === 401) {
			const refreshedTokens = await refresh()
			response = await fetchIslandRouterApi({
				url,
				init: {
					...init,
					headers: {
						...(init.headers as Record<string, string>),
						authorization: refreshedTokens.access,
					},
				},
				timeoutMs,
				allowInsecureTls: config.islandRouterApiAllowInsecureTls,
				fetchImpl,
			})
			if (response.status === 401) {
				const message =
					'Island Router API request remained unauthorized after refresh.'
				await updateIslandRouterApiAuthStatus({
					storage,
					connectorId,
					lastAuthenticatedAt:
						(await getIslandRouterApiAuthStatus(storage, connectorId))
							?.lastAuthenticatedAt ?? null,
					lastAuthError: message,
				})
				throw new Error(message)
			}
		}
		const body = await parseJsonResponse(response)
		if (!response.ok) {
			throw new Error(islandRouterHttpFailureMessage(response.status, body))
		}
		return {
			method,
			path,
			query: requestInput.query ?? null,
			status: response.status,
			data: body,
		}
	}

	return {
		writeConfirmation: islandRouterApiWriteConfirmation,
		async getStatus() {
			const hasStoredPin = await hasIslandRouterApiStoredPin(
				storage,
				connectorId,
			)
			const pin = storage.sharedSecret
				? await getIslandRouterApiPin(storage, connectorId)
				: null
			const authStatus = await getIslandRouterApiAuthStatus(
				storage,
				connectorId,
			)
			return {
				configured: Boolean(storage.sharedSecret && hasStoredPin && pin),
				hasStoredPin,
				lastAuthenticatedAt: authStatus?.lastAuthenticatedAt ?? null,
				lastAuthError: authStatus?.lastAuthError ?? null,
				baseUrl: config.islandRouterApiBaseUrl,
			}
		},
		async setPin(pin: string) {
			const trimmed = pin.trim()
			if (!trimmed) {
				throw new Error('Island Router API PIN must not be empty.')
			}
			await saveIslandRouterApiPin({
				storage,
				connectorId,
				pin: trimmed,
			})
			tokens = null
			return this.getStatus()
		},
		async clearPin() {
			await clearIslandRouterApiPin(storage, connectorId)
			tokens = null
			return this.getStatus()
		},
		request,
	}
}
