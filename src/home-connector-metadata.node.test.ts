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
			mocksEnabled: false,
		})

		const metadata = buildHomeConnectorRuntimeMetadata({
			config,
			state,
			env: {
				APP_COMMIT_SHA: '10ee90cd1e435b4faed9e746215d68c0cea3ad2d',
				KODY_USERNAME: 'kentcdodds',
				NODE_ENV: 'production',
				SENTRY_DSN: 'https://example.ingest.sentry.io/1',
				SENTRY_ENVIRONMENT: 'production',
			},
		})

		expect(metadata).toMatchObject({
			service: 'home-connector',
			appCommitSha: '10ee90cd1e435b4faed9e746215d68c0cea3ad2d',
			connectorId: config.homeConnectorId,
			kodyUsername: 'kentcdodds',
			nodeEnv: 'production',
			mocksEnabled: false,
			sentryEnabled: true,
			sentryEnvironment: 'production',
			sharedSecretConfigured: Boolean(config.sharedSecret),
		})
		expect(metadata.nodeVersion).toMatch(/^v\d+/)
		expect(metadata.processUptimeSeconds).toBeGreaterThanOrEqual(0)
	})

	test('buildHomeConnectorHealthPayload nests metadata with connection state', () => {
		const config = loadHomeConnectorConfig()
		const state = createAppState()
		updateConnectionState(state, {
			connectorId: 'default',
			connected: true,
			lastSyncAt: '2026-06-25T17:00:00.000Z',
			toolInventoryStatus: 'registered',
			toolInventoryStatusReason: 'Registered with worker.',
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
			metadata: expect.objectContaining({
				appCommitSha: 'abc123',
			}),
			connection: {
				connected: true,
				lastSyncAt: '2026-06-25T17:00:00.000Z',
				lastError: null,
			},
			toolInventory: {
				status: 'registered',
				reason: 'Registered with worker.',
				localToolCount: 135,
				lastToolsChangedNotificationAt: null,
				lastToolsListRequestAt: null,
				recoveryCount: 0,
			},
		})
	})
})
