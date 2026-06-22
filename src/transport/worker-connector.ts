import {
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js'
import {
	type ConnectorHelloMessage,
	type ConnectorJsonRpcEnvelope,
	type KodyToConnectorMessage,
	stringifyConnectorMessage,
} from '@kody-bot/connector-kit/protocol'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorState, updateConnectionState } from '../state.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'
import {
	addHomeConnectorSentryBreadcrumb,
	captureHomeConnectorException,
	captureHomeConnectorMessage,
} from '../sentry.ts'
import { type HomeConnectorLogger } from '../logging/index.ts'

const heartbeatIntervalMs = 10_000
const initialReconnectDelayMs = 2_000
const maxReconnectDelayMs = 30_000
const slowToolCallThresholdMs = 5_000
const websocketSentryReconnectThreshold = 3
const toolInventoryRegistrationGraceMs = 5_000
const maxToolInventoryRefreshAttempts = 2
const toolInventoryReconnectCloseCode = 4_000
const toolInventoryReconnectReason = 'tool inventory registration recovery'
const homeConnectorDescription =
	'Local-network home automation for Sonos, Bond shades, Venstar thermostats, Roku, Samsung TVs, Lutron, JellyFish lighting, and network gear.'

function isJsonRpcResponse(
	message: JSONRPCMessage,
): message is JSONRPCResponse {
	return 'id' in message && ('result' in message || 'error' in message)
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
	return 'id' in message && 'method' in message
}

function createToolsChangedNotification(): JSONRPCMessage {
	return {
		jsonrpc: '2.0',
		method: 'notifications/tools/list_changed',
	}
}

function formatRequestId(id: JSONRPCRequest['id']) {
	if (typeof id === 'string' || typeof id === 'number') {
		return String(id)
	}
	return JSON.stringify(id)
}

function formatCloseMessage(event: CloseEvent) {
	const reason = event.reason ? ` reason=${event.reason}` : ''
	return `Home connector websocket closed code=${event.code} wasClean=${event.wasClean}${reason}`
}

function getReconnectDelayMs(consecutiveReconnects: number) {
	const backoffMultiplier = 2 ** Math.max(0, consecutiveReconnects - 1)
	return Math.min(
		initialReconnectDelayMs * backoffMultiplier,
		maxReconnectDelayMs,
	)
}

function createSocketEventContext(input: {
	config: HomeConnectorConfig
	connectionAttempt: number
	consecutiveReconnects: number
}) {
	return {
		attempt: input.connectionAttempt,
		consecutiveReconnects: input.consecutiveReconnects,
		connectorId: input.config.homeConnectorId,
		url: input.config.workerWebSocketUrl,
	}
}

function createSocketPayloadPreview(data: unknown) {
	const raw = String(data)
	const maxPreviewLength = 500
	if (raw.length <= maxPreviewLength) {
		return {
			rawMessagePreview: raw,
			rawMessageLength: raw.length,
		}
	}
	return {
		rawMessagePreview: `${raw.slice(0, maxPreviewLength)}...[truncated]`,
		rawMessageLength: raw.length,
	}
}

async function handleJsonRpcRequest(
	message: JSONRPCRequest,
	toolRegistry: HomeConnectorToolRegistry,
	logger: HomeConnectorLogger,
	onToolsListRequest: (toolCount: number) => void,
) {
	if (message.method === 'tools/list') {
		const tools = toolRegistry.list()
		onToolsListRequest(tools.length)
		return {
			jsonrpc: '2.0',
			id: message.id,
			result: {
				tools,
			},
		} satisfies JSONRPCResponse
	}

	if (message.method === 'tools/call') {
		const params = (message.params ?? {}) as {
			name?: string
			arguments?: Record<string, unknown>
		}
		const name = params.name?.trim()
		if (!name) {
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32602,
					message: 'Missing tool name.',
				},
			} satisfies JSONRPCResponse
		}

		const startedAt = Date.now()
		const requestId = formatRequestId(message.id)
		const argumentKeys = Object.keys(params.arguments ?? {})
		logger.info(
			'tool.call.started',
			`Home connector tool call started: ${name} requestId=${requestId} argKeys=${argumentKeys.join(',') || 'none'}`,
			{
				toolName: name,
				requestId,
				argumentKeys,
			},
		)

		try {
			const result = await toolRegistry.call(name, params.arguments ?? {}, {
				requestId,
				transport: 'websocket',
				source: 'worker-connector',
			})
			const durationMs = Date.now() - startedAt
			logger.info(
				'tool.call.finished',
				`Home connector tool call finished: ${name} requestId=${requestId} durationMs=${durationMs}`,
				{
					toolName: name,
					requestId,
					durationMs,
					argumentKeys,
				},
			)
			if (durationMs >= slowToolCallThresholdMs) {
				logger.warn('tool.call.slow', 'Home connector tool call was slow.', {
					toolName: name,
					requestId,
					durationMs,
					argumentKeys,
				})
				captureHomeConnectorMessage('Home connector tool call was slow.', {
					level: 'warning',
					tags: {
						connector_event: 'tool_call.slow',
						connector_tool_name: name,
					},
					extra: {
						durationMs,
						requestId,
						argumentKeys,
					},
				})
			}
			return {
				jsonrpc: '2.0',
				id: message.id,
				result,
			} satisfies JSONRPCResponse
		} catch (error: unknown) {
			const durationMs = Date.now() - startedAt
			logger.error(
				'tool.call.failed',
				`Home connector tool call failed: ${name} requestId=${requestId} durationMs=${durationMs}`,
				{
					toolName: name,
					requestId,
					durationMs,
					argumentKeys,
					error,
				},
			)
			captureHomeConnectorException(error, {
				tags: {
					connector_tool_name: name,
				},
				contexts: {
					mcp_request: {
						method: message.method,
						requestId,
						durationMs,
						argumentKeys,
					},
				},
			})
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : String(error),
				},
			} satisfies JSONRPCResponse
		}
	}

	return {
		jsonrpc: '2.0',
		id: message.id,
		error: {
			code: -32601,
			message: `Connector request handling is not implemented for ${message.method}.`,
		},
	} satisfies JSONRPCResponse
}

export function createWorkerConnector(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	logger: HomeConnectorLogger
	toolRegistry: HomeConnectorToolRegistry
}) {
	let started = false
	let stopped = false
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let socket: WebSocket | null = null
	let hasReportedSocketIssue = false
	let connectionAttempt = 0
	let consecutiveReconnects = 0
	let toolInventoryTimer: ReturnType<typeof setTimeout> | null = null
	let toolsListRequestedForConnection = false
	let toolInventoryRefreshAttempts = 0

	const heartbeat = setInterval(() => {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(
				stringifyConnectorMessage({
					type: 'connector.heartbeat',
				}),
			)
		}
	}, heartbeatIntervalMs)

	function clearReconnectTimer() {
		if (!reconnectTimer) return
		clearTimeout(reconnectTimer)
		reconnectTimer = null
	}

	function clearToolInventoryTimer() {
		if (!toolInventoryTimer) return
		clearTimeout(toolInventoryTimer)
		toolInventoryTimer = null
	}

	function updateToolInventoryStatus(inputStatus: {
		localToolCount: number
		status: HomeConnectorState['connection']['toolInventoryStatus']
		reason: string
		lastToolsChangedNotificationAt?: string
		lastToolsListRequestAt?: string
		recoveryCount?: number
	}) {
		updateConnectionState(input.state, {
			localToolCount: inputStatus.localToolCount,
			toolInventoryStatus: inputStatus.status,
			toolInventoryStatusReason: inputStatus.reason,
			...(inputStatus.lastToolsChangedNotificationAt
				? {
						lastToolsChangedNotificationAt:
							inputStatus.lastToolsChangedNotificationAt,
					}
				: {}),
			...(inputStatus.lastToolsListRequestAt
				? { lastToolsListRequestAt: inputStatus.lastToolsListRequestAt }
				: {}),
			...(inputStatus.recoveryCount == null
				? {}
				: { toolInventoryRecoveryCount: inputStatus.recoveryCount }),
		})
	}

	function listLocalTools() {
		return input.toolRegistry.list()
	}

	function sendToolsChangedNotification(reason: string) {
		const localToolCount = listLocalTools().length
		const sentAt = new Date().toISOString()
		updateToolInventoryStatus({
			localToolCount,
			status: localToolCount > 0 ? 'refresh_requested' : 'empty_local_registry',
			reason:
				localToolCount > 0
					? `Sent tools/list_changed notification to refresh remote registry (${reason}).`
					: `Local registry is empty while trying to refresh remote registry (${reason}).`,
			lastToolsChangedNotificationAt: sentAt,
			recoveryCount: input.state.connection.toolInventoryRecoveryCount,
		})
		input.logger.info(
			'worker.tools.list_changed_sent',
			`Sending home connector tools changed notification reason=${reason} localToolCount=${localToolCount}`,
			{
				...createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
				reason,
				localToolCount,
			},
		)
		if (socket?.readyState !== WebSocket.OPEN) {
			return localToolCount
		}
		addHomeConnectorSentryBreadcrumb({
			message: 'Sending home connector tools changed notification.',
			category: 'tools.list_changed.sent',
			level: 'info',
			data: {
				...createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
				reason,
				localToolCount,
			},
		})
		socket.send(
			stringifyConnectorMessage({
				type: 'connector.jsonrpc',
				message: createToolsChangedNotification(),
			}),
		)
		return localToolCount
	}

	function handleToolsListRequest(toolCount: number) {
		toolsListRequestedForConnection = true
		toolInventoryRefreshAttempts = 0
		const listedAt = new Date().toISOString()
		if (toolCount > 0) {
			clearToolInventoryTimer()
			updateToolInventoryStatus({
				localToolCount: toolCount,
				status: 'registered',
				reason: `Kody requested tools/list and the connector returned ${toolCount} local tool(s).`,
				lastToolsListRequestAt: listedAt,
				recoveryCount: input.state.connection.toolInventoryRecoveryCount,
			})
			input.logger.info(
				'worker.tools.listed',
				`Home connector returned ${toolCount} tool(s) for remote registry refresh.`,
				{
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects,
					}),
					localToolCount: toolCount,
				},
			)
			return
		}

		updateToolInventoryStatus({
			localToolCount: toolCount,
			status: 'empty_local_registry',
			reason:
				'Kody requested tools/list, but the connector local tool registry was empty.',
			lastToolsListRequestAt: listedAt,
			recoveryCount: input.state.connection.toolInventoryRecoveryCount,
		})
		input.logger.warn(
			'worker.tools.empty_registry',
			'Home connector local tool registry is empty during tools/list.',
			createSocketEventContext({
				config: input.config,
				connectionAttempt,
				consecutiveReconnects,
			}),
		)
		scheduleToolInventoryMonitor(connectionAttempt)
	}

	function recoverToolInventoryRegistration(expectedConnectionAttempt: number) {
		toolInventoryTimer = null
		if (
			stopped ||
			expectedConnectionAttempt !== connectionAttempt ||
			socket?.readyState !== WebSocket.OPEN
		) {
			return
		}

		const localToolCount = listLocalTools().length
		toolInventoryRefreshAttempts += 1
		if (localToolCount === 0) {
			updateToolInventoryStatus({
				localToolCount,
				status: 'empty_local_registry',
				reason: `Local registry is still empty after grace period; refresh attempt ${toolInventoryRefreshAttempts}.`,
				recoveryCount: input.state.connection.toolInventoryRecoveryCount,
			})
			input.logger.warn(
				'worker.tools.empty_registry_recovery',
				`Home connector local tool registry is empty after grace period attempt=${toolInventoryRefreshAttempts}.`,
				{
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects,
					}),
					attempt: toolInventoryRefreshAttempts,
				},
			)
		} else {
			const missingListReason = toolsListRequestedForConnection
				? `Local registry recovered to ${localToolCount} tool(s), but Kody previously received an empty tools/list response for this session; refresh attempt ${toolInventoryRefreshAttempts}.`
				: `Transport is connected with ${localToolCount} local tool(s), but Kody has not requested tools/list for this session; refresh attempt ${toolInventoryRefreshAttempts}.`
			const missingListMessage = toolsListRequestedForConnection
				? `Home connector local tool registry recovered after an empty tools/list response attempt=${toolInventoryRefreshAttempts} localToolCount=${localToolCount}.`
				: `Kody has not requested home connector tools/list after ack attempt=${toolInventoryRefreshAttempts} localToolCount=${localToolCount}.`
			updateToolInventoryStatus({
				localToolCount,
				status: 'refresh_requested',
				reason: missingListReason,
				recoveryCount: input.state.connection.toolInventoryRecoveryCount,
			})
			input.logger.warn(
				'worker.tools.remote_list_missing',
				missingListMessage,
				{
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects,
					}),
					attempt: toolInventoryRefreshAttempts,
					localToolCount,
				},
			)
		}

		if (toolInventoryRefreshAttempts <= maxToolInventoryRefreshAttempts) {
			sendToolsChangedNotification(
				localToolCount === 0
					? 'empty-local-registry-retry'
					: 'missing-remote-tools-list-retry',
			)
			scheduleToolInventoryMonitor(expectedConnectionAttempt)
			return
		}

		if (localToolCount === 0 && toolsListRequestedForConnection) {
			updateToolInventoryStatus({
				localToolCount,
				status: 'empty_local_registry',
				reason:
					'Kody requested tools/list, but the connector local tool registry stayed empty after retries. Websocket reconnect is not expected to rebuild a process-local registry.',
				recoveryCount: input.state.connection.toolInventoryRecoveryCount,
			})
			input.logger.error(
				'worker.tools.empty_registry_persistent',
				'Home connector local tool registry stayed empty after Kody requested tools/list.',
				{
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects,
					}),
					localToolCount,
					attempts: toolInventoryRefreshAttempts,
				},
			)
			captureHomeConnectorMessage(
				'Home connector local tool registry stayed empty.',
				{
					level: 'error',
					fingerprint: [
						'home-connector',
						'empty-local-tool-registry',
						input.config.homeConnectorId,
					],
					tags: {
						home_connector_id: input.config.homeConnectorId,
						connector_event: 'tool_inventory.empty_local_registry',
					},
					contexts: {
						tool_inventory: {
							localToolCount,
							attempts: toolInventoryRefreshAttempts,
							toolsListRequestedForConnection,
						},
					},
				},
			)
			return
		}

		const recoveryCount = input.state.connection.toolInventoryRecoveryCount + 1
		updateToolInventoryStatus({
			localToolCount,
			status: 'reconnecting_after_missing_remote_list',
			reason:
				localToolCount === 0
					? 'Local tool registry remained empty after retries; reconnecting websocket session to rebuild registration state.'
					: 'Kody did not request tools/list after retries; reconnecting websocket session to rebuild remote registration state.',
			recoveryCount,
		})
		input.logger.error(
			'worker.tools.inventory_reconnect',
			`Reconnecting home connector websocket to recover tool inventory registration localToolCount=${localToolCount}.`,
			{
				...createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
				localToolCount,
				attempts: toolInventoryRefreshAttempts,
				recoveryCount,
				toolsListRequestedForConnection,
			},
		)
		captureHomeConnectorMessage(
			'Home connector tool inventory registration did not complete.',
			{
				level: 'error',
				fingerprint: [
					'home-connector',
					'tool-inventory-registration',
					input.config.homeConnectorId,
				],
				tags: {
					home_connector_id: input.config.homeConnectorId,
					connector_event: 'tool_inventory.registration_incomplete',
				},
				contexts: {
					tool_inventory: {
						localToolCount,
						attempts: toolInventoryRefreshAttempts,
						recoveryCount,
						toolsListRequestedForConnection,
					},
				},
			},
		)
		socket.close(toolInventoryReconnectCloseCode, toolInventoryReconnectReason)
	}

	function scheduleToolInventoryMonitor(expectedConnectionAttempt: number) {
		if (stopped) return
		clearToolInventoryTimer()
		toolInventoryTimer = setTimeout(() => {
			recoverToolInventoryRegistration(expectedConnectionAttempt)
		}, toolInventoryRegistrationGraceMs)
	}

	function scheduleReconnect() {
		if (stopped || reconnectTimer) return
		consecutiveReconnects += 1
		const reconnectDelayMs = getReconnectDelayMs(consecutiveReconnects)
		input.logger.info(
			'worker.websocket.reconnect_scheduled',
			`Scheduling home connector websocket reconnect in ${reconnectDelayMs}ms consecutiveReconnects=${consecutiveReconnects}`,
			{
				...createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
				reconnectDelayMs,
			},
		)
		addHomeConnectorSentryBreadcrumb({
			message: 'Scheduling home connector websocket reconnect.',
			category: 'websocket.reconnect_scheduled',
			level: 'info',
			data: {
				...createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
				reconnectDelayMs,
			},
		})
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null
			connect()
		}, reconnectDelayMs)
	}

	function connect() {
		if (stopped || !input.config.sharedSecret) {
			return
		}
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			return
		}
		clearReconnectTimer()
		clearToolInventoryTimer()
		toolsListRequestedForConnection = false
		toolInventoryRefreshAttempts = 0
		connectionAttempt += 1
		updateConnectionState(input.state, {
			connected: false,
			lastError: null,
			toolInventoryStatus: 'not_connected',
			toolInventoryStatusReason:
				'Opening websocket transport; tool inventory is not registered yet.',
		})
		input.logger.info(
			'worker.websocket.connecting',
			`Opening home connector websocket attempt=${connectionAttempt} url=${input.config.workerWebSocketUrl}`,
			createSocketEventContext({
				config: input.config,
				connectionAttempt,
				consecutiveReconnects,
			}),
		)
		addHomeConnectorSentryBreadcrumb({
			message: 'Opening home connector websocket.',
			category: 'websocket.connecting',
			level: 'info',
			data: createSocketEventContext({
				config: input.config,
				connectionAttempt,
				consecutiveReconnects,
			}),
		})
		socket = new WebSocket(input.config.workerWebSocketUrl)

		socket.addEventListener('open', () => {
			input.logger.info(
				'worker.websocket.opened',
				`Home connector websocket opened attempt=${connectionAttempt} connectorId=${input.config.homeConnectorId}`,
				createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
			)
			addHomeConnectorSentryBreadcrumb({
				message: 'Home connector websocket opened.',
				category: 'websocket.open',
				level: 'info',
				data: createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
			})
			const hello: ConnectorHelloMessage = {
				type: 'connector.hello',
				connectorKind: 'home',
				connectorId: input.config.homeConnectorId,
				description: homeConnectorDescription,
				sharedSecret: input.config.sharedSecret!,
			}
			addHomeConnectorSentryBreadcrumb({
				message: 'Sending home connector websocket hello.',
				category: 'websocket.hello_sent',
				level: 'info',
				data: createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
			})
			socket?.send(stringifyConnectorMessage(hello))
		})

		socket.addEventListener('message', async (event) => {
			try {
				const value = JSON.parse(String(event.data)) as
					| KodyToConnectorMessage
					| ConnectorJsonRpcEnvelope
				switch (value.type) {
					case 'server.ping':
						hasReportedSocketIssue = false
						consecutiveReconnects = 0
						updateConnectionState(input.state, {
							lastSyncAt: new Date().toISOString(),
							lastError: null,
						})
						return
					case 'server.error':
						clearToolInventoryTimer()
						updateConnectionState(input.state, {
							connected: false,
							lastError: value.message,
							toolInventoryStatus: 'not_connected',
							toolInventoryStatusReason:
								'Kody reported a server error for this connector session.',
						})
						captureHomeConnectorMessage(value.message, {
							level: 'error',
							tags: {
								connector_event: 'server.error',
							},
							extra: createSocketEventContext({
								config: input.config,
								connectionAttempt,
								consecutiveReconnects,
							}),
						})
						input.logger.error(
							'worker.server.error',
							`Home connector error: ${value.message}`,
							{
								...createSocketEventContext({
									config: input.config,
									connectionAttempt,
									consecutiveReconnects,
								}),
								serverMessage: value.message,
							},
						)
						return
					case 'server.ack': {
						hasReportedSocketIssue = false
						const previousConsecutiveReconnects = consecutiveReconnects
						consecutiveReconnects = 0
						toolsListRequestedForConnection = false
						toolInventoryRefreshAttempts = 0
						const localToolCount = listLocalTools().length
						updateConnectionState(input.state, {
							connected: true,
							lastSyncAt: new Date().toISOString(),
							lastError: null,
							localToolCount,
							toolInventoryStatus:
								localToolCount > 0
									? 'pending_remote_list'
									: 'empty_local_registry',
							toolInventoryStatusReason:
								localToolCount > 0
									? `Transport is connected with ${localToolCount} local tool(s); waiting for Kody to request tools/list.`
									: 'Transport is connected, but the local tool registry is empty.',
						})
						input.logger.info(
							'worker.websocket.acknowledged',
							`Home connector websocket acknowledged connectorId=${value.connectorId} localToolCount=${localToolCount}`,
							{
								...createSocketEventContext({
									config: input.config,
									connectionAttempt,
									consecutiveReconnects: previousConsecutiveReconnects,
								}),
								acknowledgedConnectorId: value.connectorId,
								localToolCount,
							},
						)
						addHomeConnectorSentryBreadcrumb({
							message: 'Home connector websocket acknowledged.',
							category: 'websocket.ack',
							level: 'info',
							data: {
								...createSocketEventContext({
									config: input.config,
									connectionAttempt,
									consecutiveReconnects: previousConsecutiveReconnects,
								}),
								acknowledgedConnectorId: value.connectorId,
								localToolCount,
							},
						})
						sendToolsChangedNotification('server-ack')
						scheduleToolInventoryMonitor(connectionAttempt)
						return
					}
					case 'connector.jsonrpc': {
						const message = value.message
						if (isJsonRpcResponse(message)) {
							updateConnectionState(input.state, {
								lastSyncAt: new Date().toISOString(),
								lastError: null,
							})
							return
						}
						if (
							isJsonRpcRequest(message) &&
							socket?.readyState === WebSocket.OPEN
						) {
							const response = await handleJsonRpcRequest(
								message,
								input.toolRegistry,
								input.logger,
								handleToolsListRequest,
							)
							socket.send(
								stringifyConnectorMessage({
									type: 'connector.jsonrpc',
									message: response,
								}),
							)
							updateConnectionState(input.state, {
								lastSyncAt: new Date().toISOString(),
								lastError: null,
							})
						}
						return
					}
				}
			} catch (error) {
				updateConnectionState(input.state, {
					lastError:
						error instanceof Error
							? error.message
							: 'Home connector websocket message handling failed.',
				})
				captureHomeConnectorException(error, {
					tags: {
						connector_event: 'websocket.message_error',
					},
					contexts: {
						websocket: {
							...createSocketEventContext({
								config: input.config,
								connectionAttempt,
								consecutiveReconnects,
							}),
							readyState: socket?.readyState ?? null,
						},
					},
					extra: {
						...createSocketPayloadPreview(event.data),
					},
				})
				input.logger.error(
					'worker.websocket.message_failed',
					'Home connector websocket message handling failed',
					{
						...createSocketEventContext({
							config: input.config,
							connectionAttempt,
							consecutiveReconnects,
						}),
						readyState: socket?.readyState ?? null,
						...createSocketPayloadPreview(event.data),
						error,
					},
				)
			}
		})

		socket.addEventListener('close', (event) => {
			clearToolInventoryTimer()
			const closeMessage = formatCloseMessage(event)
			const nextConsecutiveReconnects = stopped
				? consecutiveReconnects
				: consecutiveReconnects + 1
			const isToolInventoryRecoveryClose =
				event.code === toolInventoryReconnectCloseCode ||
				event.reason === toolInventoryReconnectReason ||
				input.state.connection.toolInventoryStatus ===
					'reconnecting_after_missing_remote_list'
			updateConnectionState(input.state, {
				connected: false,
				lastError: closeMessage,
				...(isToolInventoryRecoveryClose
					? {}
					: {
							toolInventoryStatus: 'not_connected',
							toolInventoryStatusReason:
								'Websocket transport is closed; remote tool inventory is unavailable.',
						}),
			})
			addHomeConnectorSentryBreadcrumb({
				message: closeMessage,
				category: 'websocket.close',
				level: event.wasClean ? 'info' : 'warning',
				data: {
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects: nextConsecutiveReconnects,
					}),
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				},
			})
			if (
				!stopped &&
				!hasReportedSocketIssue &&
				nextConsecutiveReconnects >= websocketSentryReconnectThreshold
			) {
				hasReportedSocketIssue = true
				captureHomeConnectorMessage(
					'Home connector websocket reconnects are failing.',
					{
						level: 'error',
						fingerprint: [
							'home-connector',
							'websocket-sustained-reconnect',
							input.config.homeConnectorId,
						],
						tags: {
							home_connector_id: input.config.homeConnectorId,
							connector_event: 'websocket.sustained_reconnect',
						},
						contexts: {
							websocket: {
								...createSocketEventContext({
									config: input.config,
									connectionAttempt,
									consecutiveReconnects: nextConsecutiveReconnects,
								}),
								code: event.code,
								reason: event.reason,
								wasClean: event.wasClean,
								reconnectThreshold: websocketSentryReconnectThreshold,
							},
						},
						extra: {
							closeMessage,
						},
					},
				)
			}
			input.logger.warn('worker.websocket.closed', closeMessage, {
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
				...createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
			})
			socket = null
			scheduleReconnect()
		})

		socket.addEventListener('error', (event) => {
			clearToolInventoryTimer()
			updateConnectionState(input.state, {
				connected: false,
				lastError: 'Home connector websocket error.',
				toolInventoryStatus: 'not_connected',
				toolInventoryStatusReason:
					'Websocket transport error; remote tool inventory is unavailable.',
			})
			addHomeConnectorSentryBreadcrumb({
				message: 'Home connector websocket error.',
				category: 'websocket.error',
				level: 'warning',
				data: {
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects,
					}),
					eventType: event.type,
					readyState: socket?.readyState,
				},
			})
			input.logger.error(
				'worker.websocket.error',
				'Home connector websocket error',
				{
					eventType: event.type,
					readyState: socket?.readyState,
					url: input.config.workerWebSocketUrl,
					attempt: connectionAttempt,
				},
			)
		})
	}

	return {
		async start() {
			if (started) return
			started = true
			if (!input.config.sharedSecret) {
				const message =
					'Connector registration is disabled because HOME_CONNECTOR_SHARED_SECRET is not set. Start from the repo root with `npm run dev` or provide the secret manually.'
				updateConnectionState(input.state, {
					connected: false,
					lastError: message,
					toolInventoryStatus: 'not_connected',
					toolInventoryStatusReason:
						'Registration is disabled because the shared secret is missing.',
				})
				input.logger.warn('worker.registration.disabled', message, {
					connectorId: input.config.homeConnectorId,
					workerUrl: input.config.workerBaseUrl,
				})
				return
			}
			connect()
		},
		stop() {
			stopped = true
			input.logger.info(
				'worker.stopped',
				'Stopping home connector websocket.',
				{
					connectorId: input.config.homeConnectorId,
					readyState: socket?.readyState ?? null,
				},
			)
			clearReconnectTimer()
			clearToolInventoryTimer()
			clearInterval(heartbeat)
			socket?.close()
			socket = null
		},
	}
}
