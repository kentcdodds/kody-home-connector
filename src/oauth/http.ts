import {
	OAuthError,
	OAuthErrorCode,
	type AuthInfo,
	type OAuthMetadata,
	type OAuthTokenVerifier,
	oauthMetadataResponse,
	requireBearerAuth,
	getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/server'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorStorage } from '../storage/index.ts'
import {
	assertClientIdIsMetadataUrl,
	assertRedirectUriIsAllowed,
	fetchClientIdMetadataDocument,
} from './cimd.ts'
import { verifyS256CodeChallenge } from './pkce.ts'
import {
	accessTokenTtlSeconds,
	authorizationCodeTtlSeconds,
	consumeAuthorizationCode,
	createOAuthSecret,
	hashOAuthSecret,
	insertAuthorizationCode,
	insertOAuthToken,
	mcpOAuthScope,
	readActiveOAuthToken,
	refreshTokenTtlSeconds,
	revokeOAuthToken,
} from './store.ts'

export function createHomeMcpOAuthMetadata(
	config: HomeConnectorConfig,
): OAuthMetadata {
	const issuer = config.publicBaseUrl
	return {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		revocation_endpoint: `${issuer}/revoke`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [mcpOAuthScope],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
	} as OAuthMetadata
}

export function createHomeMcpAuthMetadataOptions(config: HomeConnectorConfig) {
	return {
		oauthMetadata: createHomeMcpOAuthMetadata(config),
		resourceServerUrl: new URL(config.mcpUrl),
		scopesSupported: [mcpOAuthScope],
		resourceName: 'Kody Home MCP',
		dangerouslyAllowInsecureIssuerUrl:
			!config.publicBaseUrl.startsWith('https://'),
	}
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000)
}

function htmlResponse(body: string, status = 200) {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}

function oauthErrorRedirect(input: {
	redirectUri: string
	error: string
	description: string
	state?: string | null
}) {
	const url = new URL(input.redirectUri)
	url.searchParams.set('error', input.error)
	url.searchParams.set('error_description', input.description)
	if (input.state) url.searchParams.set('state', input.state)
	return Response.redirect(url.toString(), 302)
}

function jsonError(status: number, error: string, description: string) {
	return Response.json({ error, error_description: description }, { status })
}

function renderAuthorizePage(input: {
	clientName: string
	query: string
	error?: string
}) {
	const error = input.error
		? `<p role="alert">${escapeHtml(input.error)}</p>`
		: ''
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize Kody Home</title></head><body><main><h1>Allow ${escapeHtml(input.clientName)}?</h1><p>This client will be able to call home-automation tools on this MCP server. Public <code>/authorize</code> is gated by Cloudflare Access. The LAN origin is trusted.</p>${error}<form method="post" action="/authorize"><input type="hidden" name="intent" value="approve"><input type="hidden" name="query" value="${escapeHtml(input.query)}"><button type="submit">Approve</button></form></main></body></html>`
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

function createTokenVerifier(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
}): OAuthTokenVerifier {
	return {
		async verifyAccessToken(token: string): Promise<AuthInfo> {
			const record = readActiveOAuthToken(
				input.storage.db,
				hashOAuthSecret(token),
				nowSeconds(),
			)
			if (!record || record.tokenKind !== 'access') {
				throw new OAuthError(
					OAuthErrorCode.InvalidToken,
					'Invalid access token.',
				)
			}
			if (record.resource !== input.config.mcpUrl) {
				throw new OAuthError(
					OAuthErrorCode.InvalidToken,
					'Access token audience does not match this MCP server.',
				)
			}
			return {
				token,
				clientId: record.clientId,
				scopes: record.scope.split(' ').filter(Boolean),
				expiresAt: record.expiresAt,
				resource: new URL(record.resource),
			}
		},
	}
}

async function handleAuthorizeGet(input: {
	request: Request
	config: HomeConnectorConfig
}) {
	const url = new URL(input.request.url)
	const clientId = url.searchParams.get('client_id') ?? ''
	const redirectUri = url.searchParams.get('redirect_uri') ?? ''
	const state = url.searchParams.get('state')
	try {
		assertClientIdIsMetadataUrl({
			clientId,
			allowInsecureLoopback: !input.config.publicBaseUrl.startsWith('https://'),
		})
		const metadata = await fetchClientIdMetadataDocument({ clientId })
		assertRedirectUriIsAllowed({
			redirectUri,
			redirectUris: metadata.redirect_uris,
		})
		return htmlResponse(
			renderAuthorizePage({
				clientName: metadata.client_name ?? clientId,
				query: url.search,
			}),
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid request.'
		if (redirectUri) {
			return oauthErrorRedirect({
				redirectUri,
				error: 'invalid_request',
				description: message,
				state,
			})
		}
		return htmlResponse(`<p>${escapeHtml(message)}</p>`, 400)
	}
}

async function handleAuthorizePost(input: {
	request: Request
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
}) {
	const form = await input.request.formData()
	const query = String(form.get('query') ?? '')
	const params = new URLSearchParams(
		query.startsWith('?') ? query.slice(1) : query,
	)
	const intent = String(form.get('intent') ?? '')
	const clientId = params.get('client_id') ?? ''
	const redirectUri = params.get('redirect_uri') ?? ''
	const state = params.get('state')
	const codeChallenge = params.get('code_challenge') ?? ''
	const codeChallengeMethod = params.get('code_challenge_method') ?? ''
	const resource = params.get('resource') ?? input.config.mcpUrl
	const scope = params.get('scope') ?? mcpOAuthScope

	if (intent !== 'approve') {
		return htmlResponse(
			renderAuthorizePage({
				clientName: clientId,
				query,
				error: 'Approve this client to continue.',
			}),
			400,
		)
	}

	try {
		if (params.get('response_type') !== 'code') {
			throw new Error('response_type must be code.')
		}
		if (codeChallengeMethod !== 'S256' || !codeChallenge) {
			throw new Error('PKCE S256 code_challenge is required.')
		}
		if (resource !== input.config.mcpUrl) {
			throw new Error('resource must be this server MCP URL.')
		}
		assertClientIdIsMetadataUrl({
			clientId,
			allowInsecureLoopback: !input.config.publicBaseUrl.startsWith('https://'),
		})
		const metadata = await fetchClientIdMetadataDocument({ clientId })
		assertRedirectUriIsAllowed({
			redirectUri,
			redirectUris: metadata.redirect_uris,
		})
		const code = createOAuthSecret()
		insertAuthorizationCode(input.storage.db, {
			codeHash: hashOAuthSecret(code),
			clientId,
			redirectUri,
			codeChallenge,
			codeChallengeMethod,
			resource,
			scope,
			expiresAt: nowSeconds() + authorizationCodeTtlSeconds,
			consumedAt: null,
		})
		const redirect = new URL(redirectUri)
		redirect.searchParams.set('code', code)
		if (state) redirect.searchParams.set('state', state)
		redirect.searchParams.set('iss', input.config.publicBaseUrl)
		return Response.redirect(redirect.toString(), 302)
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid request.'
		if (redirectUri) {
			return oauthErrorRedirect({
				redirectUri,
				error: 'invalid_request',
				description: message,
				state,
			})
		}
		return htmlResponse(`<p>${escapeHtml(message)}</p>`, 400)
	}
}

async function handleToken(input: {
	request: Request
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
}) {
	const form = await input.request.formData()
	const grantType = String(form.get('grant_type') ?? '')
	if (grantType === 'authorization_code') {
		const code = String(form.get('code') ?? '')
		const redirectUri = String(form.get('redirect_uri') ?? '')
		const clientId = String(form.get('client_id') ?? '')
		const codeVerifier = String(form.get('code_verifier') ?? '')
		const record = consumeAuthorizationCode(
			input.storage.db,
			hashOAuthSecret(code),
			nowSeconds(),
		)
		if (
			!record ||
			record.clientId !== clientId ||
			record.redirectUri !== redirectUri ||
			!verifyS256CodeChallenge({
				codeVerifier,
				codeChallenge: record.codeChallenge,
			})
		) {
			return jsonError(400, 'invalid_grant', 'Authorization code is invalid.')
		}
		return issueTokenPair({
			storage: input.storage,
			clientId,
			resource: record.resource,
			scope: record.scope,
		})
	}
	if (grantType === 'refresh_token') {
		const refreshToken = String(form.get('refresh_token') ?? '')
		const clientId = String(form.get('client_id') ?? '')
		const record = readActiveOAuthToken(
			input.storage.db,
			hashOAuthSecret(refreshToken),
			nowSeconds(),
		)
		if (
			!record ||
			record.tokenKind !== 'refresh' ||
			record.clientId !== clientId
		) {
			return jsonError(400, 'invalid_grant', 'Refresh token is invalid.')
		}
		revokeOAuthToken(input.storage.db, record.tokenHash)
		return issueTokenPair({
			storage: input.storage,
			clientId,
			resource: record.resource,
			scope: record.scope,
		})
	}
	return jsonError(400, 'unsupported_grant_type', 'Unsupported grant_type.')
}

function issueTokenPair(input: {
	storage: HomeConnectorStorage
	clientId: string
	resource: string
	scope: string
}) {
	const accessToken = createOAuthSecret()
	const refreshToken = createOAuthSecret()
	const issuedAt = nowSeconds()
	insertOAuthToken(input.storage.db, {
		tokenHash: hashOAuthSecret(accessToken),
		tokenKind: 'access',
		clientId: input.clientId,
		resource: input.resource,
		scope: input.scope,
		expiresAt: issuedAt + accessTokenTtlSeconds,
		revokedAt: null,
	})
	insertOAuthToken(input.storage.db, {
		tokenHash: hashOAuthSecret(refreshToken),
		tokenKind: 'refresh',
		clientId: input.clientId,
		resource: input.resource,
		scope: input.scope,
		expiresAt: issuedAt + refreshTokenTtlSeconds,
		revokedAt: null,
	})
	return Response.json({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: accessTokenTtlSeconds,
		refresh_token: refreshToken,
		scope: input.scope,
	})
}

async function handleRevoke(input: {
	request: Request
	storage: HomeConnectorStorage
}) {
	const form = await input.request.formData()
	const token = String(form.get('token') ?? '')
	if (token) {
		revokeOAuthToken(input.storage.db, hashOAuthSecret(token))
	}
	return new Response(null, { status: 200 })
}

export function createHomeMcpOAuthHandler(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
}) {
	const authMetadata = createHomeMcpAuthMetadataOptions(input.config)
	const bearerGate = requireBearerAuth({
		verifier: createTokenVerifier(input),
		requiredScopes: [mcpOAuthScope],
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
			new URL(input.config.mcpUrl),
		),
	})

	return {
		authMetadata,
		async handle(request: Request): Promise<Response | null> {
			const metadata = oauthMetadataResponse(request, authMetadata)
			if (metadata) return metadata

			const url = new URL(request.url)
			if (url.pathname === '/authorize') {
				if (request.method === 'GET') {
					return handleAuthorizeGet({ request, config: input.config })
				}
				if (request.method === 'POST') {
					return handleAuthorizePost({
						request,
						config: input.config,
						storage: input.storage,
					})
				}
				return new Response('Method Not Allowed', { status: 405 })
			}
			if (url.pathname === '/token' && request.method === 'POST') {
				return handleToken({
					request,
					config: input.config,
					storage: input.storage,
				})
			}
			if (url.pathname === '/revoke' && request.method === 'POST') {
				return handleRevoke({ request, storage: input.storage })
			}
			return null
		},
		async authenticateMcp(request: Request) {
			return bearerGate(request)
		},
	}
}
