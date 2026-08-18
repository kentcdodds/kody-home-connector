export type ClientIdMetadataDocument = {
	client_id: string
	client_name?: string
	redirect_uris: Array<string>
	grant_types?: Array<string>
	response_types?: Array<string>
	token_endpoint_auth_method?: string
}

export function isHttpsClientId(clientId: string) {
	try {
		const url = new URL(clientId)
		return url.protocol === 'https:'
	} catch {
		return false
	}
}

export function isLoopbackClientId(clientId: string) {
	try {
		const url = new URL(clientId)
		const hostname = url.hostname.toLowerCase()
		return (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '[::1]'
		)
	} catch {
		return false
	}
}

export function assertClientIdIsMetadataUrl(input: {
	clientId: string
	allowInsecureLoopback: boolean
}) {
	if (isHttpsClientId(input.clientId)) return
	if (input.allowInsecureLoopback && isLoopbackClientId(input.clientId)) {
		return
	}
	throw new Error('client_id must be an HTTPS Client ID Metadata Document URL.')
}

export async function fetchClientIdMetadataDocument(input: {
	clientId: string
	fetchImpl?: typeof fetch
}): Promise<ClientIdMetadataDocument> {
	const response = await (input.fetchImpl ?? fetch)(input.clientId, {
		headers: { Accept: 'application/json' },
		redirect: 'error',
	})
	if (!response.ok) {
		throw new Error(
			`Failed to fetch Client ID Metadata Document (${response.status}).`,
		)
	}
	const document = (await response.json()) as Partial<ClientIdMetadataDocument>
	if (document.client_id !== input.clientId) {
		throw new Error(
			'Client ID Metadata Document client_id must match the requested URL.',
		)
	}
	if (
		!Array.isArray(document.redirect_uris) ||
		document.redirect_uris.length === 0 ||
		document.redirect_uris.some((uri) => typeof uri !== 'string' || !uri)
	) {
		throw new Error('Client ID Metadata Document must include redirect_uris.')
	}
	return {
		client_id: document.client_id,
		...(document.client_name ? { client_name: document.client_name } : {}),
		redirect_uris: document.redirect_uris,
		...(document.grant_types ? { grant_types: document.grant_types } : {}),
		...(document.response_types
			? { response_types: document.response_types }
			: {}),
		...(document.token_endpoint_auth_method
			? { token_endpoint_auth_method: document.token_endpoint_auth_method }
			: {}),
	}
}

export function assertRedirectUriIsAllowed(input: {
	redirectUri: string
	redirectUris: Array<string>
}) {
	if (!input.redirectUris.includes(input.redirectUri)) {
		throw new Error('redirect_uri is not registered on the client metadata.')
	}
}
