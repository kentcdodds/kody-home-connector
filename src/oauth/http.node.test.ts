import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { createTestHomeConnectorConfig } from '../test-home-connector-config.ts'
import { createHomeMcpOAuthHandler } from './http.ts'
import { accessTokenTtlSeconds } from './store.ts'

const clientId = 'https://kody.codes/oauth/client-metadata.json'
const redirectUri = 'https://kody.codes/account/mcp-servers/oauth/callback'

type IssuedTokens = {
	access_token: string
	token_type: string
	expires_in: number
	refresh_token: string
	scope: string
}

function createCodeChallenge(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url')
}

async function createOAuthApp() {
	const config = createTestHomeConnectorConfig({
		publicBaseUrl: 'https://kody-home.doddsfamily.us',
	})
	const storage = await createHomeConnectorStorage(config)
	const oauth = createHomeMcpOAuthHandler({ config, storage })
	return { config, storage, oauth }
}

async function dispatch(
	oauth: ReturnType<typeof createHomeMcpOAuthHandler>,
	request: Request,
) {
	return oauth.handle(request)
}

test('authorization server metadata advertises CIMD and no DCR', async () => {
	const { storage, oauth } = await createOAuthApp()
	try {
		const response = await dispatch(
			oauth,
			new Request(
				'https://kody-home.doddsfamily.us/.well-known/oauth-authorization-server',
			),
		)
		expect(response?.status).toBe(200)
		const body = (await response?.json()) as Record<string, unknown>
		expect(body.client_id_metadata_document_supported).toBe(true)
		expect(body.authorization_endpoint).toBe(
			'https://kody-home.doddsfamily.us/authorize',
		)
		expect(body.grant_types_supported).toEqual([
			'authorization_code',
			'refresh_token',
		])
		expect(body.scopes_supported).toEqual(['mcp'])
		expect(body.registration_endpoint).toBeUndefined()
	} finally {
		await storage.close()
	}
})

test('protected resource metadata points at the MCP URL', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	try {
		const response = await dispatch(
			oauth,
			new Request(
				'https://kody-home.doddsfamily.us/.well-known/oauth-protected-resource/mcp',
			),
		)
		expect(response?.status).toBe(200)
		const body = (await response?.json()) as {
			resource: string
			authorization_servers: Array<string>
		}
		expect(body.resource).toBe(config.mcpUrl)
		expect(body.authorization_servers).toContain(config.publicBaseUrl)
	} finally {
		await storage.close()
	}
})

test('/mcp without a bearer token returns 401 with resource_metadata', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	try {
		const response = await oauth.authenticateMcp(
			new Request(config.mcpUrl, { method: 'POST' }),
		)
		expect(response).toBeInstanceOf(Response)
		if (!(response instanceof Response)) {
			throw new Error('expected challenge response')
		}
		expect(response.status).toBe(401)
		const challenge = response.headers.get('WWW-Authenticate') ?? ''
		expect(challenge).toContain('resource_metadata')
		expect(challenge).toContain('oauth-protected-resource')
	} finally {
		await storage.close()
	}
})

function mockClientMetadataFetch(clientName = 'Kody') {
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url !== clientId) {
			throw new Error(`unexpected fetch ${url}`)
		}
		return Response.json({
			client_id: clientId,
			client_name: clientName,
			redirect_uris: [redirectUri],
		})
	}) as typeof fetch
	return () => {
		globalThis.fetch = originalFetch
	}
}

function createAuthorizeQuery(
	mcpUrl: string,
	input: { verifier?: string; scope?: string } = {},
) {
	const verifier = input.verifier ?? 'a'.repeat(43)
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirectUri,
		code_challenge: createCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource: mcpUrl,
		state: 'abc',
	})
	if (input.scope !== undefined) {
		query.set('scope', input.scope)
	} else {
		query.set('scope', 'mcp')
	}
	return query
}

async function exchangeAuthorizationCode(input: {
	oauth: ReturnType<typeof createHomeMcpOAuthHandler>
	mcpUrl: string
	verifier?: string
	scope?: string
}) {
	const verifier = input.verifier ?? 'a'.repeat(43)
	const query = createAuthorizeQuery(input.mcpUrl, {
		verifier,
		scope: input.scope,
	})
	const approve = await dispatch(
		input.oauth,
		new Request('https://kody-home.doddsfamily.us/authorize', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				intent: 'approve',
				query: `?${query.toString()}`,
			}),
		}),
	)
	const code = new URL(approve?.headers.get('Location') ?? '').searchParams.get(
		'code',
	)
	const token = await dispatch(
		input.oauth,
		new Request('https://kody-home.doddsfamily.us/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code: code ?? '',
				redirect_uri: redirectUri,
				client_id: clientId,
				code_verifier: verifier,
			}),
		}),
	)
	return token
}

async function refreshAccessToken(input: {
	oauth: ReturnType<typeof createHomeMcpOAuthHandler>
	refreshToken: string
}) {
	return dispatch(
		input.oauth,
		new Request('https://kody-home.doddsfamily.us/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: input.refreshToken,
				client_id: clientId,
			}),
		}),
	)
}

test('GET /authorize renders a consent page with approve and deny actions', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const restoreFetch = mockClientMetadataFetch('Kody <script>')
	try {
		const query = createAuthorizeQuery(config.mcpUrl)
		const response = await dispatch(
			oauth,
			new Request(`https://kody-home.doddsfamily.us/authorize?${query}`),
		)
		expect(response?.status).toBe(200)
		expect(response?.headers.get('Content-Type')).toContain('text/html')
		expect(response?.headers.get('Cache-Control')).toBe('no-store')
		const body = (await response?.text()) ?? ''
		expect(body).toContain('<meta name="viewport"')
		expect(body).toContain('Kody &lt;script&gt;')
		expect(body).not.toContain('Kody <script>')
		expect(body).toContain('kody-home.doddsfamily.us')
		expect(body).toContain('https://kody.codes/oauth/client-metadata.json')
		expect(body).toContain('name="intent"')
		expect(body).toContain('value="approve"')
		expect(body).toContain('value="deny"')
		expect(body).toContain(
			`value="?${query.toString().replaceAll('&', '&amp;')}"`,
		)
		expect(body).toContain("[data-tone='neutral']")
		expect(body).not.toContain('&#39;')
	} finally {
		restoreFetch()
		await storage.close()
	}
})

test('GET /authorize without a redirect_uri renders a styled error page', async () => {
	const { storage, oauth } = await createOAuthApp()
	try {
		const response = await dispatch(
			oauth,
			new Request(
				'https://kody-home.doddsfamily.us/authorize?client_id=not-a-url',
			),
		)
		expect(response?.status).toBe(400)
		expect(response?.headers.get('Content-Type')).toContain('text/html')
		const body = (await response?.text()) ?? ''
		expect(body).toContain('role="alert"')
		expect(body).toContain(
			'client_id must be an HTTPS Client ID Metadata Document URL.',
		)
		expect(body).not.toContain('value="approve"')
	} finally {
		await storage.close()
	}
})

test('invalid authorize requests redirect back with invalid_request and iss', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const restoreFetch = mockClientMetadataFetch()
	try {
		const query = createAuthorizeQuery(config.mcpUrl)
		query.set('response_type', 'token')
		const response = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/authorize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					intent: 'approve',
					query: `?${query.toString()}`,
				}),
			}),
		)
		expect(response?.status).toBe(302)
		const redirected = new URL(response?.headers.get('Location') ?? '')
		expect(redirected.origin + redirected.pathname).toBe(redirectUri)
		expect(redirected.searchParams.get('error')).toBe('invalid_request')
		expect(redirected.searchParams.get('state')).toBe('abc')
		expect(redirected.searchParams.get('iss')).toBe(config.publicBaseUrl)
		expect(redirected.searchParams.get('code')).toBeNull()
	} finally {
		restoreFetch()
		await storage.close()
	}
})

test('denying the consent page redirects with access_denied and no code', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const restoreFetch = mockClientMetadataFetch()
	try {
		const query = createAuthorizeQuery(config.mcpUrl)
		const response = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/authorize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					intent: 'deny',
					query: `?${query.toString()}`,
				}),
			}),
		)
		expect(response?.status).toBe(302)
		const redirected = new URL(response?.headers.get('Location') ?? '')
		expect(redirected.origin + redirected.pathname).toBe(redirectUri)
		expect(redirected.searchParams.get('error')).toBe('access_denied')
		expect(redirected.searchParams.get('state')).toBe('abc')
		expect(redirected.searchParams.get('iss')).toBe(config.publicBaseUrl)
		expect(redirected.searchParams.get('code')).toBeNull()
	} finally {
		restoreFetch()
		await storage.close()
	}
})

test('an unknown intent re-renders the consent page as a 400', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	try {
		const query = createAuthorizeQuery(config.mcpUrl)
		const response = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/authorize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					intent: 'maybe',
					query: `?${query.toString()}`,
				}),
			}),
		)
		expect(response?.status).toBe(400)
		const body = (await response?.text()) ?? ''
		expect(body).toContain('role="alert"')
		expect(body).toContain('Allow kody.codes to control your home?')
		expect(body).toContain('value="approve"')
	} finally {
		await storage.close()
	}
})

test('CIMD authorize + PKCE issues a bearer token for the MCP resource', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const verifier = 'a'.repeat(43)
	const challenge = createCodeChallenge(verifier)
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url !== clientId) {
			throw new Error(`unexpected fetch ${url}`)
		}
		return Response.json({
			client_id: clientId,
			client_name: 'Kody',
			redirect_uris: [redirectUri],
		})
	}) as typeof fetch
	try {
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirectUri,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			resource: config.mcpUrl,
			scope: 'mcp',
			state: 'abc',
		})
		const approve = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/authorize', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					intent: 'approve',
					query: `?${query.toString()}`,
				}),
			}),
		)
		expect(approve?.status).toBe(302)
		const location = approve?.headers.get('Location') ?? ''
		const redirected = new URL(location)
		expect(redirected.origin + redirected.pathname).toBe(redirectUri)
		expect(redirected.searchParams.get('iss')).toBe(config.publicBaseUrl)
		const code = redirected.searchParams.get('code')
		expect(code).toBeTruthy()

		const token = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code: code ?? '',
					redirect_uri: redirectUri,
					client_id: clientId,
					code_verifier: verifier,
				}),
			}),
		)
		expect(token?.status).toBe(200)
		const issued = (await token?.json()) as IssuedTokens
		expect(issued.token_type).toBe('Bearer')
		expect(issued.expires_in).toBe(accessTokenTtlSeconds)
		expect(issued.refresh_token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
		expect(issued.refresh_token).not.toBe(issued.access_token)
		expect(issued.scope).toBe('mcp')

		const auth = await oauth.authenticateMcp(
			new Request(config.mcpUrl, {
				headers: { Authorization: `Bearer ${issued.access_token}` },
			}),
		)
		expect(auth).not.toBeInstanceOf(Response)
		if (auth instanceof Response) {
			throw new Error('expected AuthInfo')
		}
		expect(auth.clientId).toBe(clientId)
		expect(auth.resource?.toString().replace(/\/$/, '')).toBe(config.mcpUrl)
	} finally {
		globalThis.fetch = originalFetch
		await storage.close()
	}
})

test('authorization code exchange issues a refresh token without offline_access', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const restoreFetch = mockClientMetadataFetch()
	try {
		const token = await exchangeAuthorizationCode({
			oauth,
			mcpUrl: config.mcpUrl,
		})
		expect(token?.status).toBe(200)
		const issued = (await token?.json()) as IssuedTokens
		expect(issued.refresh_token).toBeTruthy()
		expect(issued.scope).toBe('mcp')
		expect(Object.hasOwn(issued, 'refresh_token')).toBe(true)
	} finally {
		restoreFetch()
		await storage.close()
	}
})

test('refresh grant returns a new access token and reuses the same refresh token', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const restoreFetch = mockClientMetadataFetch()
	try {
		const token = await exchangeAuthorizationCode({
			oauth,
			mcpUrl: config.mcpUrl,
		})
		const issued = (await token?.json()) as IssuedTokens
		const refreshed = await refreshAccessToken({
			oauth,
			refreshToken: issued.refresh_token,
		})
		expect(refreshed?.status).toBe(200)
		const next = (await refreshed?.json()) as IssuedTokens
		expect(next.access_token).not.toBe(issued.access_token)
		expect(next.refresh_token).toBe(issued.refresh_token)
		expect(next.expires_in).toBe(accessTokenTtlSeconds)

		const auth = await oauth.authenticateMcp(
			new Request(config.mcpUrl, {
				headers: { Authorization: `Bearer ${next.access_token}` },
			}),
		)
		expect(auth).not.toBeInstanceOf(Response)

		const again = await refreshAccessToken({
			oauth,
			refreshToken: issued.refresh_token,
		})
		expect(again?.status).toBe(200)
		const third = (await again?.json()) as IssuedTokens
		expect(third.refresh_token).toBe(issued.refresh_token)
		expect(third.access_token).not.toBe(next.access_token)
	} finally {
		restoreFetch()
		await storage.close()
	}
})

test('concurrent refresh grants both succeed with the same refresh token', async () => {
	const { storage, oauth, config } = await createOAuthApp()
	const restoreFetch = mockClientMetadataFetch()
	try {
		const token = await exchangeAuthorizationCode({
			oauth,
			mcpUrl: config.mcpUrl,
		})
		const issued = (await token?.json()) as IssuedTokens
		const [first, second] = await Promise.all([
			refreshAccessToken({ oauth, refreshToken: issued.refresh_token }),
			refreshAccessToken({ oauth, refreshToken: issued.refresh_token }),
		])
		expect(first?.status).toBe(200)
		expect(second?.status).toBe(200)
		const a = (await first?.json()) as IssuedTokens
		const b = (await second?.json()) as IssuedTokens
		expect(a.refresh_token).toBe(issued.refresh_token)
		expect(b.refresh_token).toBe(issued.refresh_token)
		expect(a.access_token).not.toBe(b.access_token)

		const later = await refreshAccessToken({
			oauth,
			refreshToken: issued.refresh_token,
		})
		expect(later?.status).toBe(200)
	} finally {
		restoreFetch()
		await storage.close()
	}
})

test('hashed oauth tokens survive reopening a file-backed sqlite database', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-oauth-'))
	const config = createTestHomeConnectorConfig({
		publicBaseUrl: 'https://kody-home.doddsfamily.us',
		dataPath: directory,
		dbPath: path.join(directory, 'home-connector.sqlite'),
	})
	const restoreFetch = mockClientMetadataFetch()
	let refreshToken = ''
	try {
		const firstStorage = await createHomeConnectorStorage(config)
		try {
			const oauth = createHomeMcpOAuthHandler({ config, storage: firstStorage })
			const token = await exchangeAuthorizationCode({
				oauth,
				mcpUrl: config.mcpUrl,
			})
			const issued = (await token?.json()) as IssuedTokens
			refreshToken = issued.refresh_token
			expect(refreshToken).toBeTruthy()
		} finally {
			await firstStorage.close()
		}

		const reopened = await createHomeConnectorStorage(config)
		try {
			const oauth = createHomeMcpOAuthHandler({ config, storage: reopened })
			const refreshed = await refreshAccessToken({ oauth, refreshToken })
			expect(refreshed?.status).toBe(200)
			const next = (await refreshed?.json()) as IssuedTokens
			expect(next.refresh_token).toBe(refreshToken)
			const auth = await oauth.authenticateMcp(
				new Request(config.mcpUrl, {
					headers: { Authorization: `Bearer ${next.access_token}` },
				}),
			)
			expect(auth).not.toBeInstanceOf(Response)
		} finally {
			await reopened.close()
		}
	} finally {
		restoreFetch()
	}
})
