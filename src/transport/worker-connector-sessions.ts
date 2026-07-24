import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorLogger } from '../logging/index.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'
import {
	initializeWorkerSessionStates,
	type HomeConnectorState,
} from '../state.ts'
import { createWorkerConnector } from './worker-connector.ts'

export type HomeConnectorWorkerConnectorSessions = {
	start(): Promise<void>
	stop(): void
	notifyToolsListChanged(reason: string): void
	sessionCount: number
}

/**
 * Starts one independent Worker WebSocket session per configured target.
 * All sessions share the same local tool registry / device adapters. Inventory
 * refresh notifications fan out to every connected session.
 */
export function createWorkerConnectorSessions(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	logger: HomeConnectorLogger
	toolRegistry: HomeConnectorToolRegistry
}): HomeConnectorWorkerConnectorSessions {
	initializeWorkerSessionStates(
		input.state,
		input.config.workerTargets.map((target) => ({
			kodyUsername: target.kodyUsername,
			homeConnectorId: target.homeConnectorId,
			workerBaseUrl: target.workerBaseUrl,
			workerSessionUrl: target.workerSessionUrl,
			workerWebSocketUrl: target.workerWebSocketUrl,
			sharedSecret: target.sharedSecret,
			mocksEnabled: input.config.mocksEnabled,
		})),
	)

	const sessions: Array<ReturnType<typeof createWorkerConnector>> = []

	function notifyToolsListChanged(reason: string) {
		input.logger.info(
			'worker.tools.list_changed_fanout',
			`Fanning out tools/list_changed to ${sessions.length} worker session(s) reason=${reason}`,
			{
				reason,
				sessionCount: sessions.length,
			},
		)
		for (const session of sessions) {
			session.notifyToolsListChanged(reason)
		}
	}

	for (const [sessionIndex, target] of input.config.workerTargets.entries()) {
		sessions.push(
			createWorkerConnector({
				config: {
					homeConnectorId: target.homeConnectorId,
					workerBaseUrl: target.workerBaseUrl,
					workerWebSocketUrl: target.workerWebSocketUrl,
					sharedSecret: target.sharedSecret,
					kodyUsername: target.kodyUsername,
				},
				state: input.state,
				sessionIndex,
				logger: input.logger,
				toolRegistry: input.toolRegistry,
				requestToolsListChangedFanout: notifyToolsListChanged,
			}),
		)
	}

	return {
		sessionCount: sessions.length,
		async start() {
			input.logger.info(
				'worker.sessions.starting',
				`Starting ${sessions.length} home connector worker session(s).`,
				{
					sessionCount: sessions.length,
					sessions: input.config.workerTargets.map((target) => ({
						kodyUsername: target.kodyUsername,
						connectorId: target.homeConnectorId,
						workerWebSocketUrl: target.workerWebSocketUrl,
						sharedSecretConfigured: Boolean(target.sharedSecret),
					})),
				},
			)
			await Promise.all(sessions.map((session) => session.start()))
		},
		stop() {
			input.logger.info(
				'worker.sessions.stopping',
				`Stopping ${sessions.length} home connector worker session(s).`,
				{ sessionCount: sessions.length },
			)
			for (const session of sessions) {
				session.stop()
			}
		},
		notifyToolsListChanged,
	}
}
