import { buildSonyIrccSoapEnvelope, sonyIrccSoapAction } from './commands.ts'
import {
	extractIrccControlUrl,
	extractXmlTag,
	isTrustedSonyIrccControlUrl,
	looksLikeSonyIrccDocument,
	normalizeSonyIrccHost,
} from './identity.ts'
import {
	sonyIrccControlPathCandidates,
	sonyIrccDefaultTimeoutMs,
	sonyIrccProbePaths,
	type SonyIrccHttpClient,
	type SonyIrccHttpResponse,
	type SonyIrccProbeEndpoint,
} from './types.ts'

function headerValue(
	headers: Record<string, string>,
	name: string,
): string | null {
	const wanted = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value
	}
	return null
}

export function createSonyIrccHttpClient(
	fetchImpl: typeof fetch = fetch,
): SonyIrccHttpClient {
	return async (input) => {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
		try {
			const response = await fetchImpl(input.url, {
				method: input.method,
				headers: input.headers,
				body: input.body,
				redirect: 'error',
				signal: controller.signal,
			})
			const body = await response.text()
			const headers: Record<string, string> = {}
			response.headers.forEach((value, key) => {
				headers[key] = value
			})
			return {
				status: response.status,
				headers,
				body,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (
				error instanceof Error &&
				(error.name === 'AbortError' || error.name === 'TimeoutError')
			) {
				throw new Error(
					`Sony IRCC request to ${input.url} timed out after ${String(input.timeoutMs)}ms.`,
				)
			}
			throw new Error(`Sony IRCC request to ${input.url} failed: ${message}`)
		} finally {
			clearTimeout(timeout)
		}
	}
}

export function buildSonyIrccProbeUrls(host: string) {
	const normalized = normalizeSonyIrccHost(host)
	if (!normalized) return []
	return sonyIrccProbePaths.map(
		(entry) => `http://${normalized}:${String(entry.port)}${entry.path}`,
	)
}

export function buildSonyIrccControlUrlCandidates(input: {
	host: string
	discoveredControlUrl?: string | null
}) {
	const host = normalizeSonyIrccHost(input.host)
	if (!host) return []
	const urls = new Set<string>()
	if (
		input.discoveredControlUrl &&
		isTrustedSonyIrccControlUrl({ host, url: input.discoveredControlUrl })
	) {
		urls.add(input.discoveredControlUrl)
	}
	for (const entry of sonyIrccControlPathCandidates) {
		urls.add(`http://${host}:${String(entry.port)}${entry.path}`)
	}
	return [...urls]
}

export async function probeSonyIrccHost(input: {
	host: string
	http: SonyIrccHttpClient
	timeoutMs?: number
}): Promise<{
	connected: boolean
	matched: boolean
	name: string | null
	model: string | null
	manufacturer: string | null
	irccControlUrl: string | null
	probedEndpoints: Array<SonyIrccProbeEndpoint>
}> {
	const host = normalizeSonyIrccHost(input.host)
	if (!host) {
		return {
			connected: false,
			matched: false,
			name: null,
			model: null,
			manufacturer: null,
			irccControlUrl: null,
			probedEndpoints: [],
		}
	}
	const timeoutMs = input.timeoutMs ?? sonyIrccDefaultTimeoutMs
	const probedEndpoints: Array<SonyIrccProbeEndpoint> = []
	let name: string | null = null
	let model: string | null = null
	let manufacturer: string | null = null
	let irccControlUrl: string | null = null
	let matched = false

	for (const url of buildSonyIrccProbeUrls(host)) {
		try {
			const response = await input.http({
				url,
				method: 'GET',
				timeoutMs,
			})
			const looksLikeIrcc = looksLikeSonyIrccDocument(response.body)
			probedEndpoints.push({
				url,
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				matched: looksLikeIrcc,
				error: looksLikeIrcc
					? null
					: response.status >= 200 && response.status < 300
						? 'Response was not a Sony IRCC / Blu-ray document.'
						: `HTTP ${String(response.status)}`,
			})
			if (!looksLikeIrcc) continue
			matched = true
			name ??= extractXmlTag(response.body, [
				'friendlyName',
				'modelName',
				'name',
			])
			model ??= extractXmlTag(response.body, ['modelName', 'modelNumber'])
			manufacturer ??= extractXmlTag(response.body, ['manufacturer'])
			irccControlUrl ??= extractIrccControlUrl({
				host,
				body: response.body,
				baseUrl: url,
			})
		} catch (error) {
			probedEndpoints.push({
				url,
				ok: false,
				status: null,
				matched: false,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return {
		connected: matched,
		matched,
		name,
		model,
		manufacturer,
		irccControlUrl,
		probedEndpoints,
	}
}

export async function sendSonyIrccCommand(input: {
	host: string
	http: SonyIrccHttpClient
	irccCode: string
	controlUrl?: string | null
	authCookie?: string | null
	psk?: string | null
	timeoutMs?: number
}): Promise<{
	ok: boolean
	httpStatus: number | null
	controlUrl: string | null
	error: string | null
	response: SonyIrccHttpResponse | null
}> {
	const timeoutMs = input.timeoutMs ?? sonyIrccDefaultTimeoutMs
	const headers: Record<string, string> = {
		'Content-Type': 'text/xml; charset=UTF-8',
		SOAPACTION: sonyIrccSoapAction,
		'X-CERS-DEVICE-ID': 'kody-home-connector:court-bluray',
		'X-CERS-DEVICE-INFO': 'kody-home-connector:court-bluray',
	}
	if (input.authCookie) {
		headers.Cookie = input.authCookie.includes('=')
			? input.authCookie
			: `auth=${input.authCookie}`
	}
	if (input.psk) {
		headers['X-Auth-PSK'] = input.psk
	}
	const body = buildSonyIrccSoapEnvelope(input.irccCode)
	let lastError: string | null = null
	for (const url of buildSonyIrccControlUrlCandidates({
		host: input.host,
		discoveredControlUrl: input.controlUrl,
	})) {
		try {
			const response = await input.http({
				url,
				method: 'POST',
				headers,
				body,
				timeoutMs,
			})
			if (response.status >= 200 && response.status < 300) {
				return {
					ok: true,
					httpStatus: response.status,
					controlUrl: url,
					error: null,
					response,
				}
			}
			lastError = `HTTP ${String(response.status)} from ${url}`
			if (response.status === 401 || response.status === 403) {
				return {
					ok: false,
					httpStatus: response.status,
					controlUrl: url,
					error: `Sony IRCC rejected the command (${String(response.status)}). Pair the player on-screen (network standby on) and store the auth cookie or PSK.`,
					response,
				}
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}
	}
	return {
		ok: false,
		httpStatus: null,
		controlUrl: input.controlUrl ?? null,
		error: lastError ?? 'Sony IRCC control endpoints did not respond.',
		response: null,
	}
}

export function readSonyAuthCookie(response: SonyIrccHttpResponse) {
	const setCookie = headerValue(response.headers, 'set-cookie')
	if (!setCookie) return null
	const auth = /(?:^|,|\s)auth=([^;,\s]+)/i.exec(setCookie)
	return auth?.[1] ?? setCookie
}
