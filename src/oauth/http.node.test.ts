import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { createTestHomeConnectorConfig } from '../test-home-connector-config.ts'
import { createHomeMcpOAuthHandler } from './http.ts'

const clientId = 'https://kody.codes/oauth/client-metadata.json'
const redirectUri = 'https://kody.codes/account/mcp-servers/oauth/callback'
const operatorPassword = 'operator-password'

function createCodeChallenge(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url')
}

function createOAuthApp() {
	const config = createTestHomeConnectorConfig({
		publicBaseUrl: 'https://kody-home.doddsfamily.us',
		operatorPassword,
	})
	const storage = createHomeConnectorStorage(config)
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
	const { storage, oauth } = createOAuthApp()
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
		expect(body.registration_endpoint).toBeUndefined()
	} finally {
		storage.close()
	}
})

test('protected resource metadata points at the MCP URL', async () => {
	const { storage, oauth, config } = createOAuthApp()
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
		storage.close()
	}
})

test('/mcp without a bearer token returns 401 with resource_metadata', async () => {
	const { storage, oauth, config } = createOAuthApp()
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
		storage.close()
	}
})

test('CIMD authorize + PKCE issues a bearer token for the MCP resource', async () => {
	const { storage, oauth, config } = createOAuthApp()
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
		const login = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/authorize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					intent: 'login',
					query: `?${query.toString()}`,
					password: operatorPassword,
				}),
			}),
		)
		expect(login?.status).toBe(302)
		const cookie = login?.headers.get('Set-Cookie') ?? ''
		expect(cookie).toContain('home_mcp_operator=')

		const approve = await dispatch(
			oauth,
			new Request('https://kody-home.doddsfamily.us/authorize', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Cookie: cookie.split(';', 1)[0] ?? '',
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
		const issued = (await token?.json()) as {
			access_token: string
			token_type: string
			expires_in: number
		}
		expect(issued.token_type).toBe('Bearer')
		expect(issued.expires_in).toBeGreaterThan(0)

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
		storage.close()
	}
})
