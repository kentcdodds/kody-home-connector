import { describe, expect, test } from 'vitest'
import { loadHomeConnectorConfig } from './config.ts'
import { createAppState, updateConnectionState } from './state.ts'
import {
	buildHomeConnectorHealthPayload,
	buildHomeConnectorRuntimeMetadata,
} from './home-connector-metadata.ts'

describe('buildHomeConnectorRuntimeMetadata', () => {
	test('includes commit sha and runtime fields from env', () => {
		const config = loadHomeConnectorConfig()
		const state = createAppState()
		updateConnectionState(state, {
			connectorId: 'default',
			mcpUrl: config.mcpUrl,
			listening: true,
			mocksEnabled: false,
			localToolCount: 12,
		})

		const metadata = buildHomeConnectorRuntimeMetadata({
			config,
			state,
			env: {
				APP_COMMIT_SHA: '10ee90cd1e435b4faed9e746215d68c0cea3ad2d',
				NODE_ENV: 'production',
				SENTRY_DSN: 'https://example.ingest.sentry.io/1',
				SENTRY_ENVIRONMENT: 'production',
			},
		})

		expect(metadata).toMatchObject({
			service: 'home-connector',
			appCommitSha: '10ee90cd1e435b4faed9e746215d68c0cea3ad2d',
			connectorId: config.homeConnectorId,
			mcpUrl: config.mcpUrl,
			publicBaseUrl: config.publicBaseUrl,
			nodeEnv: 'production',
			mocksEnabled: false,
			sentryEnabled: true,
			sentryEnvironment: 'production',
			dataKeyConfigured: Boolean(config.sharedSecret),
			localToolCount: 12,
			listening: true,
		})
		expect(metadata.nodeVersion).toMatch(/^v\d+/)
		expect(metadata.processUptimeSeconds).toBeGreaterThanOrEqual(0)
	})

	test('buildHomeConnectorHealthPayload nests metadata with MCP listening state', () => {
		const config = loadHomeConnectorConfig()
		const state = createAppState()
		updateConnectionState(state, {
			connectorId: 'default',
			mcpUrl: config.mcpUrl,
			listening: true,
			localToolCount: 135,
		})

		expect(
			buildHomeConnectorHealthPayload({
				config,
				state,
				env: { APP_COMMIT_SHA: 'abc123' },
			}),
		).toEqual({
			ok: true,
			service: 'home-connector',
			connectorId: 'default',
			mcpUrl: config.mcpUrl,
			metadata: expect.objectContaining({
				appCommitSha: 'abc123',
				mcpUrl: config.mcpUrl,
				listening: true,
				localToolCount: 135,
			}),
			connection: {
				listening: true,
				lastError: null,
			},
			tools: {
				localToolCount: 135,
			},
		})
	})
})
