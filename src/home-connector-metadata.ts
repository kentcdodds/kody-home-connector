import { type HomeConnectorConfig } from './config.ts'
import { type HomeConnectorState } from './state.ts'

export type HomeConnectorRuntimeMetadata = {
	service: 'home-connector'
	appCommitSha: string | null
	connectorId: string
	kodyUsername: string | null
	workerBaseUrl: string
	nodeVersion: string
	nodeEnv: string | null
	mocksEnabled: boolean
	sentryEnabled: boolean
	sentryEnvironment: string | null
	port: number
	processUptimeSeconds: number
	sharedSecretConfigured: boolean
}

export type HomeConnectorHealthPayload = {
	ok: true
	service: 'home-connector'
	connectorId: string
	metadata: HomeConnectorRuntimeMetadata
	connection: {
		connected: boolean
		lastSyncAt: string | null
		lastError: string | null
	}
	toolInventory: {
		status: HomeConnectorState['connection']['toolInventoryStatus']
		reason: string
		localToolCount: number
		lastToolsChangedNotificationAt: string | null
		lastToolsListRequestAt: string | null
		recoveryCount: number
	}
}

function readOptionalEnvString(
	env: NodeJS.ProcessEnv,
	name: string,
): string | null {
	const value = env[name]?.trim()
	return value ? value : null
}

export function buildHomeConnectorRuntimeMetadata(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	env?: NodeJS.ProcessEnv
}): HomeConnectorRuntimeMetadata {
	const env = input.env ?? process.env
	const sentryDsn = readOptionalEnvString(env, 'SENTRY_DSN')
	return {
		service: 'home-connector',
		appCommitSha: readOptionalEnvString(env, 'APP_COMMIT_SHA'),
		connectorId: input.config.homeConnectorId,
		kodyUsername: readOptionalEnvString(env, 'KODY_USERNAME'),
		workerBaseUrl: input.config.workerBaseUrl,
		nodeVersion: process.version,
		nodeEnv: readOptionalEnvString(env, 'NODE_ENV'),
		mocksEnabled: input.state.connection.mocksEnabled,
		sentryEnabled: Boolean(sentryDsn),
		sentryEnvironment: readOptionalEnvString(env, 'SENTRY_ENVIRONMENT'),
		port: input.config.port,
		processUptimeSeconds: Math.floor(process.uptime()),
		sharedSecretConfigured: Boolean(input.config.sharedSecret),
	}
}

export function buildHomeConnectorHealthPayload(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	env?: NodeJS.ProcessEnv
}): HomeConnectorHealthPayload {
	const { connection } = input.state
	return {
		ok: true,
		service: 'home-connector',
		connectorId: connection.connectorId,
		metadata: buildHomeConnectorRuntimeMetadata(input),
		connection: {
			connected: connection.connected,
			lastSyncAt: connection.lastSyncAt,
			lastError: connection.lastError,
		},
		toolInventory: {
			status: connection.toolInventoryStatus,
			reason: connection.toolInventoryStatusReason,
			localToolCount: connection.localToolCount,
			lastToolsChangedNotificationAt: connection.lastToolsChangedNotificationAt,
			lastToolsListRequestAt: connection.lastToolsListRequestAt,
			recoveryCount: connection.toolInventoryRecoveryCount,
		},
	}
}
