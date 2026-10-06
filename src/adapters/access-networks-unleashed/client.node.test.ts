import { afterEach, expect, test, vi } from 'vitest'
import { createAccessNetworksUnleashedAjaxClient } from './client.ts'
import { AccessNetworksUnleashedRequestError } from './errors.ts'
import { loadHomeConnectorConfig } from '../../config.ts'

const originalFetch = globalThis.fetch

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

function response(
	body: string | null,
	init: ResponseInit & { url?: string } = {},
) {
	const output = new Response(body, init)
	Object.defineProperty(output, 'url', {
		value: init.url ?? 'https://unleashed.local/admin/wsg',
	})
	return output
}

function createConfig(envOverrides: Record<string, string | undefined> = {}) {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
		ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.10.88/32',
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'true',
		...envOverrides,
	})
	return loadHomeConnectorConfig()
}

function createController() {
	return {
		controllerId: 'unleashed-1',
		name: 'Access Networks Unleashed',
		host: 'https://unleashed.local',
		loginUrl: 'https://unleashed.local/admin/wsg/login.jsp',
		lastSeenAt: '2026-05-03T19:00:00.000Z',
		rawDiscovery: null,
		adopted: true,
		username: 'admin',
		password: 'password',
		lastAuthenticatedAt: null,
		lastAuthError: null,
	}
}

afterEach(() => {
	globalThis.fetch = originalFetch
})

type FetchHandler = (
	url: string,
	init: RequestInit | undefined,
) => Promise<Response> | Response | null | undefined

function isLoginPost(href: string, init: RequestInit | undefined) {
	return (
		(init?.method === 'POST' || init?.method === 'post') &&
		href.endsWith('/login.jsp') &&
		String(init?.body ?? '').includes('username=admin')
	)
}

function loginHandler(options?: {
	loginPath?: string
	sessionCookie?: string
	dashboardPath?: string
}): FetchHandler {
	const loginPath = options?.loginPath ?? '/admin/wsg/login.jsp'
	const sessionCookie =
		options?.sessionCookie ?? 'JSESSIONID=abc; Path=/admin; HttpOnly; Secure'
	const dashboardPath = options?.dashboardPath ?? '/admin/wsg/'
	return (href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: loginPath },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith(loginPath)) {
			return response(null, {
				status: 200,
				headers: { 'set-cookie': sessionCookie },
				url: `https://unleashed.local${loginPath}`,
			})
		}
		if (isLoginPost(href, init)) {
			return response(null, {
				status: 302,
				headers: {
					Location: dashboardPath,
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': sessionCookie,
				},
				url: href,
			})
		}
		return null
	}
}

function installFetch(...handlers: Array<FetchHandler>) {
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		for (const handler of handlers) {
			const result = await handler(href, init)
			if (result) return result
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch
	return fetchMock
}

test('request posts a fully formed ajax-request envelope to _cmdstat.jsp', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><system name="Unleashed" version="200.15"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})

	expect(result.action).toBe('getstat')
	expect(result.comp).toBe('system')
	expect(result.updater).toMatch(/^system\.\d+\.[a-z0-9]+$/)
	expect(result.xml).toContain('<system')
	expect(result.parsed).toEqual({
		'ajax-response': {
			system: {
				'@name': 'Unleashed',
				'@version': '200.15',
			},
		},
	})

	const cmdCall = fetchMock.mock.calls.find(([url]) =>
		String(url).endsWith('/_cmdstat.jsp'),
	)
	const body = String(cmdCall?.[1]?.body ?? '')
	expect(body.startsWith('request=')).toBe(true)
	const decoded = decodeURIComponent(body.slice('request='.length))
	expect(decoded).toContain("action='getstat'")
	expect(decoded).toContain("comp='system'")
	expect(decoded).toContain('<sysinfo/>')
	expect(decoded).toMatch(/updater='system\.\d+\.[a-z0-9]+'/)
	const cmdHeaders = new Headers(cmdCall?.[1]?.headers)
	expect(cmdHeaders.get('Content-Type')).toBe(
		'application/x-www-form-urlencoded',
	)
	expect(cmdHeaders.get('Cookie')).toContain('JSESSIONID=abc')
	expect(cmdHeaders.get('X-CSRF-Token')).toBe('csrf-token')
})

test('login redirect back to the login page is reported as an auth error', async () => {
	const config = createConfig()
	installFetch((href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (isLoginPost(href, init)) {
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/login.jsp',
					'set-cookie': 'JSESSIONID=stale; Path=/admin',
				},
				url: href,
			})
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<sysinfo/>',
		}),
	).rejects.toThrow(/authentication failed: login was rejected/)
})

test('login without a CSRF token is reported as an auth error', async () => {
	const config = createConfig()
	installFetch((href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				headers: {
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (isLoginPost(href, init)) {
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (href.endsWith('/_csrfTokenVar.jsp')) {
			return response('no token here', { status: 200 })
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<sysinfo/>',
		}),
	).rejects.toThrow(/no CSRF token/)
})

test('200.18 -ejs-session- cookie jar + POST login succeeds without JSESSIONID', async () => {
	const config = createConfig()
	const sessionCookie =
		'-ejs-session-=ejs-session-value; Path=/admin; HttpOnly; Secure'
	const fetchMock = installFetch((href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/login.jsp')) {
			return response(null, {
				status: 200,
				headers: { 'set-cookie': sessionCookie },
				url: 'https://unleashed.local/admin/login.jsp',
			})
		}
		if (isLoginPost(href, init)) {
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/dashboard.jsp',
					'set-cookie': sessionCookie,
				},
				url: href,
			})
		}
		if (href.endsWith('/_csrfTokenVar.jsp')) {
			return response(
				"<script>var csfrToken = 'unleashed-csrf-from-jsp';</script>",
				{ status: 200 },
			)
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><system name="Unleashed" version="200.18"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})
	expect(result.parsed).toEqual({
		'ajax-response': {
			system: {
				'@name': 'Unleashed',
				'@version': '200.18',
			},
		},
	})
	const loginPost = fetchMock.mock.calls.find(([url, init]) =>
		isLoginPost(String(url), init),
	)
	expect(loginPost?.[1]?.method).toBe('POST')
	expect(String(loginPost?.[1]?.body ?? '')).toContain('username=admin')
	expect(String(loginPost?.[1]?.body ?? '')).toContain('ok=Log+In')
	const cmdHeaders = new Headers(
		fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith('/_cmdstat.jsp'),
		)?.[1]?.headers,
	)
	expect(cmdHeaders.get('Cookie')).toContain('-ejs-session-=ejs-session-value')
	expect(cmdHeaders.get('Cookie')).not.toMatch(/JSESSIONID=/)
	expect(cmdHeaders.get('X-CSRF-Token')).toBe('unleashed-csrf-from-jsp')
})

test('parses misspelled csfrToken from _csrfTokenVar.jsp with single quotes', async () => {
	const config = createConfig()
	const fetchMock = installFetch((href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (isLoginPost(href, init)) {
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (href.endsWith('/_csrfTokenVar.jsp')) {
			// Exact format captured from Unleashed 200.18.7.101 (R550).
			return response(
				"<script>var csfrToken = 'unleashed-csrf-from-jsp';</script>",
				{
					status: 200,
				},
			)
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><system name="Unleashed" version="200.18"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})
	expect(result.parsed).toEqual({
		'ajax-response': {
			system: {
				'@name': 'Unleashed',
				'@version': '200.18',
			},
		},
	})
	const cmdHeaders = new Headers(
		fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith('/_cmdstat.jsp'),
		)?.[1]?.headers,
	)
	expect(cmdHeaders.get('X-CSRF-Token')).toBe('unleashed-csrf-from-jsp')
	expect(cmdHeaders.get('Cookie')).toContain('JSESSIONID=abc')
})

test('parses csrfToken from _csrfTokenVar.jsp with double quotes', async () => {
	const config = createConfig()
	const fetchMock = installFetch((href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (isLoginPost(href, init)) {
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (href.endsWith('/_csrfTokenVar.jsp')) {
			return response(
				'<script>var csrfToken = "double-quoted-csrf";</script>',
				{
					status: 200,
				},
			)
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response('<ajax-response><ok/></ajax-response>')
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})
	const cmdHeaders = new Headers(
		fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith('/_cmdstat.jsp'),
		)?.[1]?.headers,
	)
	expect(cmdHeaders.get('X-CSRF-Token')).toBe('double-quoted-csrf')
})

test('malformed login redirect clears session cookies before retry', async () => {
	const config = createConfig()
	let credentialAttempts = 0
	const fetchMock = installFetch((href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				headers: { 'set-cookie': 'JSESSIONID=preauth; Path=/admin' },
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (isLoginPost(href, init)) {
			credentialAttempts += 1
			if (credentialAttempts === 1) {
				return response(null, {
					status: 302,
					headers: {
						Location: 'http://[',
						'set-cookie': 'JSESSIONID=stale; Path=/admin',
					},
					url: href,
				})
			}
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/',
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': 'JSESSIONID=fresh; Path=/admin',
				},
				url: href,
			})
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response('<ajax-response><ok/></ajax-response>')
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<sysinfo/>',
		}),
	).rejects.toThrow(/redirect Location was not a valid URL/)

	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})
	expect(result.parsed).toEqual({ 'ajax-response': { ok: null } })

	const loginPageCalls = fetchMock.mock.calls.filter(
		([url, init]) =>
			init?.method === 'GET' && String(url).endsWith('/admin/wsg/login.jsp'),
	)
	expect(loginPageCalls.length).toBeGreaterThanOrEqual(2)
	// After the malformed redirect failure, the next login must not reuse stale cookies.
	expect(new Headers(loginPageCalls[1]?.[1]?.headers).get('Cookie')).toBeNull()
})

test('request honors a caller-supplied updater', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response('<ajax-response><ok/></ajax-response>')
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'docmd',
		comp: 'stamgr',
		xmlBody: "<xcmd cmd='reset'/>",
		updater: 'reset.42',
	})

	expect(result.updater).toBe('reset.42')
	const cmdCall = fetchMock.mock.calls.find(([url]) =>
		String(url).endsWith('/_cmdstat.jsp'),
	)
	const decoded = decodeURIComponent(
		String(cmdCall?.[1]?.body ?? '').slice('request='.length),
	)
	expect(decoded).toContain("updater='reset.42'")
	expect(decoded).toContain("action='docmd'")
})

test('request reauthenticates once on 302 for getstat actions', async () => {
	const config = createConfig()
	let cmdAttempts = 0
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			cmdAttempts += 1
			if (cmdAttempts === 1) {
				return response(null, { status: 302 })
			}
			return response('<ajax-response><ok/></ajax-response>')
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})

	expect(result.parsed).toEqual({
		'ajax-response': { ok: null },
	})
	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		isLoginPost(String(call[0]), call[1]),
	)
	expect(loginAttempts).toHaveLength(2)
})

test('request does not retry mutating actions after a 302', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(null, { status: 302 })
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'docmd',
			comp: 'stamgr',
			xmlBody: "<xcmd cmd='reset'/>",
		}),
	).rejects.toThrow('redirected during a command')

	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		isLoginPost(String(call[0]), call[1]),
	)
	expect(loginAttempts).toHaveLength(1)
})

test('concurrent requests share one login flow', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return new Promise<Response>((resolve) => {
				setTimeout(() => {
					resolve(
						response(null, {
							status: 200,
							url: 'https://unleashed.local/admin/wsg/login.jsp',
						}),
					)
				}, 5)
			})
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><client mac="aa:bb:cc:dd:ee:ff"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await Promise.all([
		client.request({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: "<client LEVEL='1'/>",
		}),
		client.request({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: "<client LEVEL='1'/>",
		}),
	])

	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		isLoginPost(String(call[0]), call[1]),
	)
	expect(loginAttempts).toHaveLength(1)
})

test('failed login does not leave a partial session', async () => {
	const config = createConfig()
	let rejectedLogin = true
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (isLoginPost(href, init)) {
			if (rejectedLogin) {
				rejectedLogin = false
				return response(null, { status: 200, url: href })
			}
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/',
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><client mac="aa:bb:cc:dd:ee:ff"/></ajax-response>',
			)
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})

	await expect(
		client.request({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: "<client LEVEL='1'/>",
		}),
	).rejects.toThrow('login was rejected')
	const result = await client.request({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: "<client LEVEL='1'/>",
	})
	expect(result.parsed).toEqual({
		'ajax-response': {
			client: { '@mac': 'aa:bb:cc:dd:ee:ff' },
		},
	})
})

test('request rejects xmsg error responses', async () => {
	const config = createConfig()
	installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><xmsg error="1" lmsg="bad request"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'docmd',
			comp: 'stamgr',
			xmlBody: '<bogus/>',
		}),
	).rejects.toThrow('rejected the command')
})

test('request wraps certificate fetch failures as AccessNetworksUnleashedRequestError', async () => {
	const config = createConfig({
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'false',
	})
	const fetchMock = vi.fn(async () => {
		throw new TypeError('fetch failed', {
			cause: new Error(
				'unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca',
			),
		})
	})
	globalThis.fetch = fetchMock as typeof fetch

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})

	let thrown: unknown
	try {
		await client.request({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<sysinfo/>',
		})
	} catch (error) {
		thrown = error
	}

	expect(thrown).toBeInstanceOf(AccessNetworksUnleashedRequestError)
	expect((thrown as Error).name).toBe('AccessNetworksUnleashedRequestError')
	expect((thrown as Error).message).toContain(
		'ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS',
	)
	expect((thrown as Error).message).toContain('establish a session')
})
