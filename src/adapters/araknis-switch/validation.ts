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

export function getAraknisSwitchConfigStatus(
	config: HomeConnectorConfig,
): AraknisSwitchConfigStatus {
	const baseUrl = resolveAraknisSwitchBaseUrl(config)
	const missingFields: Array<string> = []
	if (!config.araknisSwitchUsername) {
		missingFields.push('ARAKNIS_SWITCH_USERNAME')
	}
	if (!config.araknisSwitchPassword) {
		missingFields.push('ARAKNIS_SWITCH_PASSWORD')
	}

	return {
		configured: missingFields.length === 0,
		baseUrl,
		host: resolveAraknisSwitchHost(baseUrl),
		missingFields,
		allowInsecureTls: config.araknisSwitchAllowInsecureTls,
		sshEnabled: config.araknisSwitchSshEnabled,
		sshPort: config.araknisSwitchSshPort,
		hasUsername: Boolean(config.araknisSwitchUsername),
		hasPassword: Boolean(config.araknisSwitchPassword),
	}
}

export function assertAraknisSwitchConfigured(config: HomeConnectorConfig) {
	const status = getAraknisSwitchConfigStatus(config)
	if (!status.configured) {
		throw new Error(
			`Araknis switch diagnostics are not configured. Missing: ${status.missingFields.join(', ')}.`,
		)
	}
	return status
}
