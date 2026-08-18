import { type HomeConnectorConfig } from './config.ts'
import { type HomeConnectorState } from './state.ts'

export type HomeConnectorRuntimeMetadata = {
	service: 'home-connector'
	appCommitSha: string | null
	connectorId: string
	mcpUrl: string
	publicBaseUrl: string
	nodeVersion: string
	nodeEnv: string | null
	mocksEnabled: boolean
	sentryEnabled: boolean
	sentryEnvironment: string | null
	port: number
	processUptimeSeconds: number
	operatorPasswordConfigured: boolean
	dataKeyConfigured: boolean
	localToolCount: number
	listening: boolean
}

export type HomeConnectorHealthPayload = {
	ok: true
	service: 'home-connector'
	connectorId: string
	mcpUrl: string
	metadata: HomeConnectorRuntimeMetadata
	connection: {
		listening: boolean
		lastError: string | null
	}
	tools: {
		localToolCount: number
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
		mcpUrl: input.config.mcpUrl,
		publicBaseUrl: input.config.publicBaseUrl,
		nodeVersion: process.version,
		nodeEnv: readOptionalEnvString(env, 'NODE_ENV'),
		mocksEnabled: input.state.connection.mocksEnabled,
		sentryEnabled: Boolean(sentryDsn),
		sentryEnvironment: readOptionalEnvString(env, 'SENTRY_ENVIRONMENT'),
		port: input.config.port,
		processUptimeSeconds: Math.floor(process.uptime()),
		operatorPasswordConfigured: Boolean(input.config.operatorPassword),
		dataKeyConfigured: Boolean(input.config.sharedSecret),
		localToolCount: input.state.connection.localToolCount,
		listening: input.state.connection.listening,
	}
}

export function buildHomeConnectorHealthPayload(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	env?: NodeJS.ProcessEnv
}): HomeConnectorHealthPayload {
	const { connection } = input.state
	const metadata = buildHomeConnectorRuntimeMetadata(input)
	return {
		ok: true,
		service: 'home-connector',
		connectorId: connection.connectorId || input.config.homeConnectorId,
		mcpUrl: input.config.mcpUrl,
		metadata,
		connection: {
			listening: connection.listening,
			lastError: connection.lastError,
		},
		tools: {
			localToolCount: connection.localToolCount,
		},
	}
}
