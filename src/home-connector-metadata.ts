import { type HomeConnectorConfig } from './config.ts'
import { type HomeConnectorState } from './state.ts'

export type HomeConnectorWorkerSessionMetadata = {
	sessionKey: string
	kodyUsername: string | null
	connectorId: string
	workerBaseUrl: string
	workerSessionUrl: string
	workerWebSocketUrl: string
	connected: boolean
	lastSyncAt: string | null
	lastError: string | null
	sharedSecretConfigured: boolean
	toolInventoryStatus: HomeConnectorState['connection']['toolInventoryStatus']
	toolInventoryStatusReason: string
	localToolCount: number
	lastToolsChangedNotificationAt: string | null
	lastToolsListRequestAt: string | null
	toolInventoryRecoveryCount: number
}

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
	workerSessionCount: number
	connectedWorkerSessionCount: number
	workerSessions: Array<HomeConnectorWorkerSessionMetadata>
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
		connectedSessionCount: number
		sessionCount: number
	}
	workerSessions: Array<HomeConnectorWorkerSessionMetadata>
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

function buildWorkerSessionMetadata(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
): Array<HomeConnectorWorkerSessionMetadata> {
	if (state.workerSessions.length > 0) {
		return state.workerSessions.map((session) => ({
			sessionKey: session.sessionKey,
			kodyUsername: session.kodyUsername,
			connectorId: session.connectorId,
			workerBaseUrl: session.workerUrl,
			workerSessionUrl: session.workerSessionUrl,
			workerWebSocketUrl: session.workerWebSocketUrl,
			connected: session.connected,
			lastSyncAt: session.lastSyncAt,
			lastError: session.lastError,
			sharedSecretConfigured: Boolean(session.sharedSecret),
			toolInventoryStatus: session.toolInventoryStatus,
			toolInventoryStatusReason: session.toolInventoryStatusReason,
			localToolCount: session.localToolCount,
			lastToolsChangedNotificationAt: session.lastToolsChangedNotificationAt,
			lastToolsListRequestAt: session.lastToolsListRequestAt,
			toolInventoryRecoveryCount: session.toolInventoryRecoveryCount,
		}))
	}

	return [
		{
			sessionKey: `${config.kodyUsername ?? 'local'}/${config.homeConnectorId}`,
			kodyUsername: config.kodyUsername,
			connectorId: config.homeConnectorId,
			workerBaseUrl: config.workerBaseUrl,
			workerSessionUrl: config.workerSessionUrl,
			workerWebSocketUrl: config.workerWebSocketUrl,
			connected: state.connection.connected,
			lastSyncAt: state.connection.lastSyncAt,
			lastError: state.connection.lastError,
			sharedSecretConfigured: Boolean(
				state.connection.sharedSecret ?? config.sharedSecret,
			),
			toolInventoryStatus: state.connection.toolInventoryStatus,
			toolInventoryStatusReason: state.connection.toolInventoryStatusReason,
			localToolCount: state.connection.localToolCount,
			lastToolsChangedNotificationAt:
				state.connection.lastToolsChangedNotificationAt,
			lastToolsListRequestAt: state.connection.lastToolsListRequestAt,
			toolInventoryRecoveryCount: state.connection.toolInventoryRecoveryCount,
		},
	]
}

export function buildHomeConnectorRuntimeMetadata(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	env?: NodeJS.ProcessEnv
}): HomeConnectorRuntimeMetadata {
	const env = input.env ?? process.env
	const sentryDsn = readOptionalEnvString(env, 'SENTRY_DSN')
	const workerSessions = buildWorkerSessionMetadata(input.state, input.config)
	const connectedWorkerSessionCount = workerSessions.filter(
		(session) => session.connected,
	).length
	return {
		service: 'home-connector',
		appCommitSha: readOptionalEnvString(env, 'APP_COMMIT_SHA'),
		connectorId: input.config.homeConnectorId,
		kodyUsername:
			input.config.kodyUsername ?? readOptionalEnvString(env, 'KODY_USERNAME'),
		workerBaseUrl: input.config.workerBaseUrl,
		nodeVersion: process.version,
		nodeEnv: readOptionalEnvString(env, 'NODE_ENV'),
		mocksEnabled: input.state.connection.mocksEnabled,
		sentryEnabled: Boolean(sentryDsn),
		sentryEnvironment: readOptionalEnvString(env, 'SENTRY_ENVIRONMENT'),
		port: input.config.port,
		processUptimeSeconds: Math.floor(process.uptime()),
		sharedSecretConfigured: Boolean(input.config.sharedSecret),
		workerSessionCount: workerSessions.length,
		connectedWorkerSessionCount,
		workerSessions,
	}
}

function selectHealthToolInventorySummary(
	sessions: Array<HomeConnectorWorkerSessionMetadata>,
	connection: HomeConnectorState['connection'],
) {
	const preferred =
		sessions.find(
			(session) =>
				session.connected && session.toolInventoryStatus === 'registered',
		) ??
		sessions.find((session) => session.connected) ??
		sessions[0]
	if (preferred) {
		return {
			status: preferred.toolInventoryStatus,
			reason: preferred.toolInventoryStatusReason,
			localToolCount: preferred.localToolCount,
			lastToolsChangedNotificationAt: preferred.lastToolsChangedNotificationAt,
			lastToolsListRequestAt: preferred.lastToolsListRequestAt,
			recoveryCount: preferred.toolInventoryRecoveryCount,
		}
	}
	return {
		status: connection.toolInventoryStatus,
		reason: connection.toolInventoryStatusReason,
		localToolCount: connection.localToolCount,
		lastToolsChangedNotificationAt: connection.lastToolsChangedNotificationAt,
		lastToolsListRequestAt: connection.lastToolsListRequestAt,
		recoveryCount: connection.toolInventoryRecoveryCount,
	}
}

export function buildHomeConnectorHealthPayload(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	env?: NodeJS.ProcessEnv
}): HomeConnectorHealthPayload {
	const { connection } = input.state
	const metadata = buildHomeConnectorRuntimeMetadata(input)
	const latestSyncAt = metadata.workerSessions.reduce<string | null>(
		(latest, session) => {
			if (!session.lastSyncAt) return latest
			if (!latest || session.lastSyncAt > latest) return session.lastSyncAt
			return latest
		},
		connection.lastSyncAt,
	)
	return {
		ok: true,
		service: 'home-connector',
		connectorId: connection.connectorId,
		metadata,
		connection: {
			connected: metadata.connectedWorkerSessionCount > 0,
			lastSyncAt: latestSyncAt,
			lastError: connection.lastError,
			connectedSessionCount: metadata.connectedWorkerSessionCount,
			sessionCount: metadata.workerSessionCount,
		},
		workerSessions: metadata.workerSessions,
		toolInventory: selectHealthToolInventorySummary(
			metadata.workerSessions,
			connection,
		),
	}
}
