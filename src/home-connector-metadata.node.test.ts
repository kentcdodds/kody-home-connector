import { describe, expect, test } from 'vitest'
import { loadHomeConnectorConfig } from './config.ts'
import {
	createAppState,
	initializeWorkerSessionStates,
	updateConnectionState,
	updateWorkerSessionState,
} from './state.ts'
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
			workerSessionCount: 1,
			connectedWorkerSessionCount: 0,
		})
		expect(metadata.workerSessions).toHaveLength(1)
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
				workerSessionCount: 1,
				connectedWorkerSessionCount: 1,
			}),
			connection: {
				connected: true,
				lastSyncAt: '2026-06-25T17:00:00.000Z',
				lastError: null,
				connectedSessionCount: 1,
				sessionCount: 1,
			},
			workerSessions: expect.arrayContaining([
				expect.objectContaining({
					connectorId: 'default',
					connected: true,
				}),
			]),
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

	test('health tool inventory prefers a healthy non-primary session', () => {
		const config = loadHomeConnectorConfig()
		const state = createAppState()
		initializeWorkerSessionStates(state, [
			{
				kodyUsername: 'alice',
				homeConnectorId: 'home',
				workerBaseUrl: 'https://heykody.app',
				workerSessionUrl: 'https://heykody.app/@alice/connectors/home',
				workerWebSocketUrl: 'wss://heykody.app/@alice/connectors/home',
				sharedSecret: 'secret-a',
				mocksEnabled: false,
			},
			{
				kodyUsername: 'bob',
				homeConnectorId: 'home',
				workerBaseUrl: 'https://heykody.app',
				workerSessionUrl: 'https://heykody.app/@bob/connectors/home',
				workerWebSocketUrl: 'wss://heykody.app/@bob/connectors/home',
				sharedSecret: 'secret-b',
				mocksEnabled: false,
			},
		])
		updateWorkerSessionState(state, 0, {
			connected: false,
			toolInventoryStatus: 'not_connected',
			toolInventoryStatusReason: 'Primary session is down.',
			localToolCount: 0,
		})
		updateWorkerSessionState(state, 1, {
			connected: true,
			toolInventoryStatus: 'registered',
			toolInventoryStatusReason: 'Secondary session registered tools.',
			localToolCount: 42,
			lastSyncAt: '2026-06-25T18:00:00.000Z',
		})

		const health = buildHomeConnectorHealthPayload({
			config,
			state,
			env: { APP_COMMIT_SHA: 'abc123' },
		})
		expect(health.connection.connected).toBe(true)
		expect(health.connection.connectedSessionCount).toBe(1)
		expect(health.toolInventory).toMatchObject({
			status: 'registered',
			reason: 'Secondary session registered tools.',
			localToolCount: 42,
		})
	})
})
