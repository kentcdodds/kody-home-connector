import { type HomeConnectorConfig } from '../../config.ts'
import { type AraknisSwitchConfigStatus } from './types.ts'

function trimTrailingSlash(value: string) {
	let trimmed = value
	while (trimmed.endsWith('/')) {
		trimmed = trimmed.slice(0, -1)
	}
	return trimmed
}

export function resolveAraknisSwitchBaseUrl(config: HomeConnectorConfig) {
	return trimTrailingSlash(
		config.araknisSwitchBaseUrl || 'https://192.168.0.50',
	)
}

export function resolveAraknisSwitchHost(baseUrl: string) {
	try {
		return new URL(baseUrl).hostname || null
	} catch {
		return null
	}
}

export function getAraknisSwitchConfigStatus(input: {
	config: HomeConnectorConfig
	hasStoredCredentials: boolean
	hasSharedSecret: boolean
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}): AraknisSwitchConfigStatus {
	const baseUrl = resolveAraknisSwitchBaseUrl(input.config)
	const missingFields: Array<string> = []
	if (!input.hasSharedSecret) {
		missingFields.push('HOME_CONNECTOR_SHARED_SECRET')
	}
	if (!input.hasStoredCredentials) {
		missingFields.push('stored credentials')
	}

	return {
		configured: missingFields.length === 0,
		baseUrl,
		host: resolveAraknisSwitchHost(baseUrl),
		missingFields,
		allowInsecureTls: input.config.araknisSwitchAllowInsecureTls,
		sshEnabled: input.config.araknisSwitchSshEnabled,
		sshPort: input.config.araknisSwitchSshPort,
		hasStoredCredentials: input.hasStoredCredentials,
		hasSharedSecret: input.hasSharedSecret,
		lastAuthenticatedAt: input.lastAuthenticatedAt ?? null,
		lastAuthError: input.lastAuthError ?? null,
	}
}

export function assertAraknisSwitchCredentialsPresent(
	credentials: { username: string; password: string } | null,
) {
	if (!credentials?.username || !credentials.password) {
		throw new Error(
			'Araknis switch credentials are not configured. Open /araknis-switch/setup on the connector LAN UI or call araknis_set_credentials.',
		)
	}
	return credentials
}
