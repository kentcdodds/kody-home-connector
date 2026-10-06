import { gunzipSync } from 'node:zlib'
import { type HomeConnectorConfig } from '../../config.ts'
import { AccessNetworksUnleashedCookieJar } from './cookie-jar.ts'
import {
	AccessNetworksUnleashedAuthError,
	createAccessNetworksUnleashedRequestError,
} from './errors.ts'
import { fetchAccessNetworksUnleashed } from './http.ts'
import { parseAccessNetworksUnleashedXml } from './xml.ts'
import {
	type AccessNetworksUnleashedAjaxAction,
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedRequestInput,
	type AccessNetworksUnleashedRequestResult,
} from './types.ts'

type SessionState = {
	baseUrl: string | null
	loginUrl: string | null
	csrfToken: string | null
	cookies: AccessNetworksUnleashedCookieJar
}

function escapeXmlAttribute(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function normalizeHost(host: string) {
	const trimmed = host.trim()
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
	return `https://${trimmed.replace(/\/+$/, '')}`
}

function generateUpdater(comp: string) {
	const safeComp = comp.replace(/[^a-zA-Z0-9_-]/g, '') || 'comp'
	const ts = Date.now()
	const rand = Math.random().toString(36).slice(2, 10)
	return `${safeComp}.${ts}.${rand}`
}

function extractCsrfToken(text: string) {
	const match =
		// Access Networks / RUCKUS Unleashed 200.18 ships a misspelled
		// `csfrToken` assignment from `_csrfTokenVar.jsp` (single or double quotes).
		/\bcsfrToken\s*=\s*(['"])([^'"]+)\1/i.exec(text) ??
		/\bcsrfToken\s*=\s*(['"])([^'"]+)\1/i.exec(text) ??
		/HTTP_X_CSRF_TOKEN["']?\s*[:=]\s*["']([^'"]+)["']/i.exec(text) ??
		/X-CSRF-Token["']?\s*[:=]\s*["']([^'"]+)["']/i.exec(text)
	if (!match) return null
	// Named `csfrToken`/`csrfToken` captures put the token in group 2; header
	// patterns keep it in group 1.
	return match[2] ?? match[1] ?? null
}

function isLoginPageUrl(url: string) {
	try {
		return /login/i.test(new URL(url).pathname)
	} catch {
		return /login/i.test(url)
	}
}

function resolveUrl(location: string, base: string) {
	try {
		return new URL(location, base).toString()
	} catch (error) {
		throw new AccessNetworksUnleashedAuthError(
			'Access Networks Unleashed authentication failed: redirect Location was not a valid URL.',
			{ cause: error },
		)
	}
}

function endpointForAction(action: AccessNetworksUnleashedAjaxAction) {
	switch (action) {
		case 'getconf':
		case 'setconf':
			return '_conf.jsp'
		case 'getstat':
		case 'docmd':
			return '_cmdstat.jsp'
		default: {
			const _exhaustive: never = action
			return _exhaustive
		}
	}
}

function isMutatingAction(action: AccessNetworksUnleashedAjaxAction) {
	switch (action) {
		case 'getstat':
		case 'getconf':
			return false
		case 'setconf':
		case 'docmd':
			return true
		default: {
			const _exhaustive: never = action
			return _exhaustive
		}
	}
}

function looksLikeVapXmlBody(xmlBody: string) {
	return /^\s*<vap(\s|\/|>)/i.test(xmlBody)
}

/**
 * aioruckus `get_vap_stats` posts:
 * `<ajax-request ... caller='SCI'><vap INTERVAL-STATS='no' LEVEL='1' /></ajax-request>`
 * Bare `<vap/>` (as used by @kentcdodds/unleashed-wifi) returns empty on fw 200.18.
 * Inject missing INTERVAL-STATS / LEVEL without discarding other attrs or children.
 */
function normalizeVapXmlBody(xmlBody: string) {
	if (!looksLikeVapXmlBody(xmlBody)) return xmlBody
	const trimmed = xmlBody.trim()

	const selfClosing = /^<vap([^>]*)\/>$/i.exec(trimmed)
	if (selfClosing) {
		return `<vap ${injectVapDefaultAttrs(selfClosing[1] ?? '')}/>`
	}

	const open = /^<vap([^>]*)>([\s\S]*)$/i.exec(trimmed)
	if (!open) return trimmed
	return `<vap ${injectVapDefaultAttrs(open[1] ?? '')}>${open[2] ?? ''}`
}

function hasExactXmlAttribute(attrs: string, name: string) {
	// Match the exact attribute name on the opening tag only (not RADIO-LEVEL
	// for LEVEL, and not attributes that only appear on child elements).
	const pattern = new RegExp(`(?:^|[\\s"'])${name}\\s*=`, 'i')
	return pattern.test(attrs)
}

function injectVapDefaultAttrs(existingAttrs: string) {
	const existing = existingAttrs.trim()
	const injections: Array<string> = []
	if (!hasExactXmlAttribute(existing, 'INTERVAL-STATS')) {
		injections.push('INTERVAL-STATS="no"')
	}
	if (!hasExactXmlAttribute(existing, 'LEVEL')) {
		injections.push('LEVEL="1"')
	}
	return [...injections, existing].filter(Boolean).join(' ')
}

function resolveExplicitCaller(caller: string | undefined) {
	return caller?.trim() ?? ''
}

function resolveGetstatCaller(input: {
	xmlBody: string
	caller: string | undefined
}) {
	const explicit = resolveExplicitCaller(input.caller)
	if (explicit) return explicit
	// aioruckus: vap and wlangroup stats require caller="SCI".
	if (
		looksLikeVapXmlBody(input.xmlBody) ||
		/^\s*<wlangroup(\s|\/|>)/i.test(input.xmlBody)
	) {
		return 'SCI'
	}
	return ''
}

function callerAttribute(caller: string) {
	return caller ? ` caller="${escapeXmlAttribute(caller)}"` : ''
}

function buildAjaxRequestEnvelope(input: {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	xmlBody: string
	updater: string | undefined
	caller: string | undefined
}): { xml: string; updater: string } {
	const { action, comp } = input
	const escapedComp = escapeXmlAttribute(comp)

	switch (action) {
		case 'getstat': {
			// fw 200.18 curl ground truth: double-quoted attrs, enable-gzip="0",
			// no updater unless the caller supplies one. VAP stats additionally
			// need caller="SCI" + INTERVAL-STATS (aioruckus get_vap_stats).
			const xmlBody = normalizeVapXmlBody(input.xmlBody)
			const updater = input.updater?.trim() ?? ''
			const updaterAttr = updater
				? ` updater="${escapeXmlAttribute(updater)}"`
				: ''
			const caller = resolveGetstatCaller({
				xmlBody,
				caller: input.caller,
			})
			return {
				updater,
				xml:
					`<ajax-request action="getstat" comp="${escapedComp}"` +
					` enable-gzip="0"${callerAttribute(caller)}${updaterAttr}>${xmlBody}</ajax-request>`,
			}
		}
		case 'getconf': {
			const xmlBody = input.xmlBody
			const updater = input.updater?.trim() || generateUpdater(comp)
			const caller = resolveExplicitCaller(input.caller)
			const attrs =
				`action="getconf" DECRYPT_X="false" ` +
				`updater="${escapeXmlAttribute(updater)}" comp="${escapedComp}"` +
				callerAttribute(caller)
			if (xmlBody.trim()) {
				return {
					updater,
					xml: `<ajax-request ${attrs}>${xmlBody}</ajax-request>`,
				}
			}
			return {
				updater,
				xml: `<ajax-request ${attrs}/>`,
			}
		}
		case 'setconf':
		case 'docmd': {
			const xmlBody = input.xmlBody
			const updater = input.updater?.trim() || generateUpdater(comp)
			const caller = resolveExplicitCaller(input.caller)
			return {
				updater,
				xml:
					`<ajax-request action="${action}" ` +
					`comp="${escapedComp}" ` +
					`updater="${escapeXmlAttribute(updater)}"` +
					`${callerAttribute(caller)}>` +
					`${xmlBody}</ajax-request>`,
			}
		}
		default: {
			const _exhaustive: never = action
			return _exhaustive
		}
	}
}

function describeEmptyResponse(response: Response) {
	const contentLength = response.headers.get('content-length')
	const contentEncoding = response.headers.get('content-encoding')
	const contentType = response.headers.get('content-type')
	return (
		`Access Networks Unleashed returned an empty response ` +
		`(status=${String(response.status)}, ` +
		`content-length=${contentLength ?? 'missing'}, ` +
		`content-encoding=${contentEncoding ?? 'missing'}, ` +
		`content-type=${contentType ?? 'missing'}).`
	)
}

function isGzipContentEncoding(value: string | null) {
	if (!value) return false
	return /(^|,)\s*(gzip|x-gzip)\s*(,|$)/i.test(value)
}

function looksLikeGzipBytes(bytes: Uint8Array) {
	// gzip magic number 1f 8b. Native fetch may already decompress while
	// leaving Content-Encoding: gzip, so only gunzip when the body is still
	// compressed (raw insecure-TLS path).
	return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

async function readResponseBodyText(response: Response) {
	const encoding = response.headers.get('content-encoding')
	if (!isGzipContentEncoding(encoding)) {
		return await response.text()
	}
	const bytes = new Uint8Array(await response.arrayBuffer())
	if (bytes.byteLength === 0) return ''
	if (!looksLikeGzipBytes(bytes)) {
		return new TextDecoder().decode(bytes)
	}
	try {
		const decompressed = gunzipSync(bytes)
		return new TextDecoder().decode(decompressed)
	} catch (error) {
		throw new Error(
			'Access Networks Unleashed returned a gzip body that could not be decoded.',
			{ cause: error },
		)
	}
}

export function createAccessNetworksUnleashedAjaxClient(input: {
	config: HomeConnectorConfig
	controller: AccessNetworksUnleashedPersistedController
}): AccessNetworksUnleashedClient {
	const { config } = input
	const state: SessionState = {
		baseUrl: null,
		loginUrl: null,
		csrfToken: null,
		cookies: new AccessNetworksUnleashedCookieJar(),
	}
	let loginPromise: Promise<void> | null = null

	function requireConfig() {
		const host = input.controller.host.trim()
		const username = input.controller.username
		const password = input.controller.password
		if (
			!host ||
			username == null ||
			password == null ||
			username.length === 0 ||
			password.length === 0
		) {
			throw new Error(
				'Access Networks Unleashed requires an adopted controller with stored credentials. Run access_networks_unleashed_scan_controllers, access_networks_unleashed_adopt_controller, then access_networks_unleashed_set_credentials.',
			)
		}
		return {
			host: normalizeHost(host),
			username,
			password,
		}
	}

	async function rawRequest(
		url: string,
		init: RequestInit,
		allowInsecureTls: boolean,
		operation: string,
		timeoutMs = config.accessNetworksUnleashedRequestTimeoutMs,
	) {
		const headers = new Headers(init.headers)
		const cookieHeader = state.cookies.headerValue()
		if (cookieHeader) headers.set('Cookie', cookieHeader)
		if (state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken)
		let response: Response
		try {
			response = await fetchAccessNetworksUnleashed({
				url,
				timeoutMs,
				allowInsecureTls,
				init: {
					...init,
					headers,
					redirect: 'manual',
				} as RequestInit,
			})
		} catch (error) {
			throw createAccessNetworksUnleashedRequestError({
				url,
				operation,
				allowInsecureTls,
				error,
			})
		}
		state.cookies.absorb(response.headers)
		return response
	}

	// Login uses the controller-wide TLS setting. The per-request override on
	// `client.request(...)` only applies to the actual AJAX post; the
	// session-establishment hops are concurrency-shared (see ensureSession),
	// so the first caller's per-request override would otherwise silently win
	// for every concurrent caller.
	async function login() {
		try {
			const allowInsecureTls = config.accessNetworksUnleashedAllowInsecureTls
			const credentials = requireConfig()
			let csrfToken: string | null = null

			// Discover the admin login URL (redirect from the controller root),
			// falling back to /admin/login.jsp used by Unleashed 200.18.
			const head = await rawRequest(
				credentials.host,
				{ method: 'GET' },
				allowInsecureTls,
				'establish a session',
				3_000,
			)
			const headLocation = head.headers.get('location')
			let loginUrl: string
			if (headLocation) {
				loginUrl = resolveUrl(headLocation, head.url || credentials.host)
			} else {
				loginUrl = new URL(
					'/admin/login.jsp',
					`${credentials.host}/`,
				).toString()
			}
			const baseUrl = new URL('.', loginUrl).toString().replace(/\/$/, '')

			// Pre-login GET establishes the session cookie (e.g. `-ejs-session-`
			// on 200.18, or JSESSIONID on older builds).
			await rawRequest(
				loginUrl,
				{
					method: 'GET',
					headers: { Accept: '*/*' },
				},
				allowInsecureTls,
				'establish a session',
			)

			const loginBody = new URLSearchParams({
				username: credentials.username,
				password: credentials.password,
				ok: 'Log In',
			}).toString()
			const loginResult = await rawRequest(
				loginUrl,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						Accept: '*/*',
					},
					body: loginBody,
				},
				allowInsecureTls,
				'establish a session',
			)
			const loginRedirect = loginResult.headers.get('location')
			const loginRedirectUrl = loginRedirect
				? resolveUrl(loginRedirect, loginUrl)
				: null
			const landedOnLoginPage =
				loginResult.status === 200 ||
				(loginRedirectUrl != null && isLoginPageUrl(loginRedirectUrl))
			if (landedOnLoginPage) {
				throw new AccessNetworksUnleashedAuthError(
					'Access Networks Unleashed authentication failed: login was rejected (still on the login page). Check stored controller credentials.',
				)
			}
			if (loginResult.status < 300 || loginResult.status >= 400) {
				throw new AccessNetworksUnleashedAuthError(
					`Access Networks Unleashed authentication failed: login returned HTTP ${String(loginResult.status)} instead of a post-login redirect.`,
				)
			}
			if (!loginRedirectUrl) {
				throw new AccessNetworksUnleashedAuthError(
					'Access Networks Unleashed authentication failed: login redirect was missing a Location header.',
				)
			}

			const csrfHeader =
				loginResult.headers.get('HTTP_X_CSRF_TOKEN') ??
				loginResult.headers.get('x-csrf-token')
			if (csrfHeader) {
				csrfToken = csrfHeader
			} else {
				const tokenResponse = await rawRequest(
					`${baseUrl}/_csrfTokenVar.jsp`,
					{ method: 'GET' },
					allowInsecureTls,
					'establish a session',
				)
				if (tokenResponse.ok) {
					csrfToken = extractCsrfToken(await tokenResponse.text())
				}
			}
			if (!csrfToken?.trim()) {
				throw new AccessNetworksUnleashedAuthError(
					'Access Networks Unleashed authentication failed: no CSRF token was returned after login.',
				)
			}
			if (state.cookies.size === 0) {
				throw new AccessNetworksUnleashedAuthError(
					'Access Networks Unleashed authentication failed: no session cookies were established after login.',
				)
			}
			state.loginUrl = loginUrl
			state.baseUrl = baseUrl
			state.csrfToken = csrfToken
		} catch (error) {
			resetSession()
			throw error
		}
	}

	async function ensureSession() {
		if (state.baseUrl) return
		loginPromise ??= login().finally(() => {
			loginPromise = null
		})
		await loginPromise
	}

	function resetSession() {
		state.baseUrl = null
		state.loginUrl = null
		state.csrfToken = null
		state.cookies.clear()
	}

	async function postAjax(
		xml: string,
		action: AccessNetworksUnleashedAjaxAction,
		allowInsecureTls: boolean,
		redirectCount = 0,
	): Promise<string> {
		await ensureSession()
		if (!state.baseUrl) {
			throw new Error('Access Networks Unleashed session has no base URL.')
		}
		const endpoint = endpointForAction(action)
		const response = await rawRequest(
			`${state.baseUrl}/${endpoint}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'text/xml',
					Accept: 'text/xml',
				},
				body: xml,
			},
			allowInsecureTls,
			`post ${endpoint}`,
		)
		if (response.status === 302) {
			resetSession()
			if (isMutatingAction(action)) {
				throw new Error(
					'Access Networks Unleashed redirected during a command. The session was reset; retry after confirming the command did not already apply.',
				)
			}
			if (redirectCount >= 1) {
				throw new Error(
					'Access Networks Unleashed redirected after reauthentication.',
				)
			}
			await ensureSession()
			return await postAjax(xml, action, allowInsecureTls, redirectCount + 1)
		}
		const text = await readResponseBodyText(response)
		if (!response.ok) {
			throw new Error(
				`Access Networks Unleashed request failed with HTTP ${response.status}: ${text.trim()}`,
			)
		}
		if (!text.trim()) {
			throw new Error(describeEmptyResponse(response))
		}
		if (
			/<xmsg\b[^>]*\b(?:error|status)=["'](?:1|true|error|failed)["']/i.test(
				text,
			)
		) {
			throw new Error(`Access Networks Unleashed rejected the command: ${text}`)
		}
		return text
	}

	return {
		async request(
			requestInput: AccessNetworksUnleashedRequestInput,
		): Promise<AccessNetworksUnleashedRequestResult> {
			const action = requestInput.action
			const comp = requestInput.comp.trim()
			if (!comp) {
				throw new Error('comp must be a non-empty Unleashed component name.')
			}
			const xmlBody = requestInput.xmlBody
			if (typeof xmlBody !== 'string') {
				throw new Error('xmlBody must be a string of inner ajax-request XML.')
			}
			const allowInsecureTls =
				requestInput.allowInsecureTls ??
				config.accessNetworksUnleashedAllowInsecureTls
			const { xml, updater } = buildAjaxRequestEnvelope({
				action,
				comp,
				xmlBody,
				updater: requestInput.updater,
				caller: requestInput.caller,
			})
			const responseXml = await postAjax(xml, action, allowInsecureTls)
			return {
				action,
				comp,
				updater,
				xml: responseXml,
				parsed: parseAccessNetworksUnleashedXml(responseXml),
			}
		},
	}
}
