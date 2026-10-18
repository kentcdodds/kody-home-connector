import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createAccessNetworksUnleashedAjaxClient } from './client.ts'
import { scanAccessNetworksUnleashedControllers } from './discovery.ts'
import { AccessNetworksUnleashedAuthError } from './errors.ts'
import {
	adoptAccessNetworksUnleashedController,
	getAccessNetworksUnleashedController,
	getAdoptedAccessNetworksUnleashedController,
	listAccessNetworksUnleashedPublicControllers,
	removeAccessNetworksUnleashedController,
	saveAccessNetworksUnleashedCredentials,
	toAccessNetworksUnleashedPublicController,
	updateAccessNetworksUnleashedAuthStatus,
	upsertDiscoveredAccessNetworksUnleashedControllers,
} from './repository.ts'
import {
	type AccessNetworksUnleashedAjaxAction,
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedConfigStatus,
	type AccessNetworksUnleashedDiscoveredController,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedRequestInput,
	type AccessNetworksUnleashedRequestResult,
} from './types.ts'
import {
	cloneWlanById,
	fetchWlanSnapshot,
	getWlanById,
	updateWlanById,
	type WlanAttributeOverrides,
} from './wlan-ops.ts'
import { xmlBodyLooksLikeFullWlanListWrite } from './wlan-xml.ts'

type ControllerCredentialsRequest = {
	controllerId: string
	username: string
	password: string
}

type ControllerSelectionRequest = {
	controllerId: string
}

type WriteOperationRequest = {
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
}

type RequestCapabilityRequest = WriteOperationRequest &
	AccessNetworksUnleashedRequestInput

export const accessNetworksUnleashedRequestConfirmation =
	'I am highly certain making this raw Access Networks Unleashed AJAX request is necessary right now.'

export const accessNetworksUnleashedWlanWriteConfirmation =
	'I am highly certain this Access Networks Unleashed per-WLAN write is necessary right now.'

const validActions: ReadonlySet<AccessNetworksUnleashedAjaxAction> =
	new Set<AccessNetworksUnleashedAjaxAction>([
		'getstat',
		'getconf',
		'setconf',
		'docmd',
	])

function assertNotWholeWlanListWrite(input: {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	xmlBody: string
}) {
	if (input.action !== 'setconf') return
	if (!xmlBodyLooksLikeFullWlanListWrite(input.xmlBody)) return
	throw new Error(
		'Refusing to setconf a whole WLAN list (wlansvc-list wrapper or multiple <wlansvc> elements). ' +
			'That pattern can overwrite the first WLAN by list position and duplicate ids ' +
			'(Oct 12 friendlyguest/friendlyfamily incident). ' +
			'Use access_networks_unleashed_update_wlan or access_networks_unleashed_clone_wlan, ' +
			'which target a single wlansvc id, snapshot first, and roll back on unexpected diffs.',
	)
}

function getConfigStatus(
	config: HomeConnectorConfig,
	controller: AccessNetworksUnleashedPersistedController | null,
): AccessNetworksUnleashedConfigStatus {
	const missingRequirements: Array<'controller' | 'credentials'> = []
	if (!controller) {
		missingRequirements.push('controller')
	}
	if (!controller?.username || !controller?.password) {
		missingRequirements.push('credentials')
	}
	return {
		configured: missingRequirements.length === 0,
		adoptedControllerId: controller?.controllerId ?? null,
		host: controller?.host ?? null,
		hasAdoptedController: Boolean(controller),
		hasStoredCredentials: Boolean(controller?.username && controller?.password),
		allowInsecureTls: config.accessNetworksUnleashedAllowInsecureTls,
		missingRequirements,
		lastAuthenticatedAt: controller?.lastAuthenticatedAt ?? null,
		lastAuthError: controller?.lastAuthError ?? null,
	}
}

function assertNonEmpty(value: string, field: string) {
	const trimmed = value.trim()
	if (!trimmed) throw new Error(`${field} must not be empty.`)
	return trimmed
}

function isAuthFailure(error: unknown) {
	return error instanceof AccessNetworksUnleashedAuthError
}

function assertWriteAllowed(
	request: WriteOperationRequest,
	expectedConfirmation: string,
) {
	if (!request.acknowledgeHighRisk) {
		throw new Error(
			'acknowledgeHighRisk must be true for this Access Networks Unleashed request.',
		)
	}
	const reason = request.reason.trim()
	if (reason.length < 20) {
		throw new Error('reason must be at least 20 characters.')
	}
	if (request.confirmation !== expectedConfirmation) {
		throw new Error(`confirmation must exactly equal: ${expectedConfirmation}`)
	}
	return reason
}

export function createAccessNetworksUnleashedAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
	clientFactory?: (
		controller: AccessNetworksUnleashedPersistedController,
	) => AccessNetworksUnleashedClient
	scanControllers?: () => Promise<{
		controllers: Array<AccessNetworksUnleashedDiscoveredController>
		diagnostics: HomeConnectorState['accessNetworksUnleashedDiscoveryDiagnostics']
	}>
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId

	function listControllers() {
		return listAccessNetworksUnleashedPublicControllers(storage, connectorId)
	}

	async function getAdoptedController() {
		const controller = await getAdoptedAccessNetworksUnleashedController(
			storage,
			connectorId,
		)
		return controller
			? toAccessNetworksUnleashedPublicController(controller)
			: null
	}

	async function requireController(controllerId: string) {
		const controller = await getAccessNetworksUnleashedController(
			storage,
			connectorId,
			controllerId,
		)
		if (!controller) {
			throw new Error(
				`Access Networks Unleashed controller "${controllerId}" was not found.`,
			)
		}
		return controller
	}

	async function requireAdoptedController() {
		const controller = await getAdoptedAccessNetworksUnleashedController(
			storage,
			connectorId,
		)
		if (!controller) {
			throw new Error(
				'No Access Networks Unleashed controller is adopted yet. Run access_networks_unleashed_scan_controllers, then access_networks_unleashed_adopt_controller.',
			)
		}
		return controller
	}

	async function requireControllerWithCredentials() {
		const controller = await requireAdoptedController()
		if (!controller.username || !controller.password) {
			throw new Error(
				'The adopted Access Networks Unleashed controller is missing stored credentials. Run access_networks_unleashed_set_credentials first.',
			)
		}
		return controller
	}

	let cachedClientKey: string | null = null
	let cachedClient: AccessNetworksUnleashedClient | null = null

	async function createClient() {
		const controller = await requireControllerWithCredentials()
		const cacheKey = JSON.stringify({
			controllerId: controller.controllerId,
			host: controller.host,
			username: controller.username,
			password: controller.password,
		})
		if (cachedClient && cachedClientKey === cacheKey) {
			return cachedClient
		}
		cachedClient =
			input.clientFactory?.(controller) ??
			createAccessNetworksUnleashedAjaxClient({
				config,
				controller,
			})
		cachedClientKey = cacheKey
		return cachedClient
	}

	return {
		requestConfirmation: accessNetworksUnleashedRequestConfirmation,
		async getConfigStatus() {
			return getConfigStatus(
				config,
				await getAdoptedAccessNetworksUnleashedController(storage, connectorId),
			)
		},
		getDiscoveryDiagnostics() {
			return state.accessNetworksUnleashedDiscoveryDiagnostics
		},
		listControllers,
		getAdoptedController,
		async scan() {
			if (input.scanControllers) {
				const result = await input.scanControllers()
				state.accessNetworksUnleashedDiscoveryDiagnostics = result.diagnostics
				await upsertDiscoveredAccessNetworksUnleashedControllers(
					storage,
					connectorId,
					result.controllers,
				)
				return listControllers()
			}
			const result = await scanAccessNetworksUnleashedControllers(state, config)
			await upsertDiscoveredAccessNetworksUnleashedControllers(
				storage,
				connectorId,
				result.controllers,
			)
			return listControllers()
		},
		async adoptController(request: ControllerSelectionRequest) {
			const controller = await requireController(request.controllerId)
			await adoptAccessNetworksUnleashedController(
				storage,
				connectorId,
				controller.controllerId,
			)
			cachedClient = null
			cachedClientKey = null
			return toAccessNetworksUnleashedPublicController({
				...controller,
				adopted: true,
			})
		},
		async removeController(request: ControllerSelectionRequest) {
			const controller = await requireController(request.controllerId)
			await removeAccessNetworksUnleashedController({
				storage,
				connectorId,
				controllerId: controller.controllerId,
			})
			cachedClient = null
			cachedClientKey = null
			return toAccessNetworksUnleashedPublicController(controller)
		},
		async setCredentials(request: ControllerCredentialsRequest) {
			await requireController(request.controllerId)
			const username = assertNonEmpty(request.username, 'username')
			const password = assertNonEmpty(request.password, 'password')
			await saveAccessNetworksUnleashedCredentials({
				storage,
				connectorId,
				controllerId: request.controllerId,
				username,
				password,
			})
			cachedClient = null
			cachedClientKey = null
			return toAccessNetworksUnleashedPublicController(
				await requireController(request.controllerId),
			)
		},
		async authenticate(controllerId?: string) {
			const controller = controllerId
				? await requireController(controllerId)
				: await requireAdoptedController()
			if (!controller.username || !controller.password) {
				throw new Error(
					`Access Networks Unleashed controller "${controller.controllerId}" is missing stored credentials. Run access_networks_unleashed_set_credentials first.`,
				)
			}
			cachedClient = null
			cachedClientKey = null
			const client =
				input.clientFactory?.(controller) ??
				createAccessNetworksUnleashedAjaxClient({
					config,
					controller,
				})
			try {
				await client.request({
					action: 'getstat',
					comp: 'system',
					xmlBody: '<sysinfo/>',
				})
				await updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: controller.controllerId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			} catch (error) {
				await updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: controller.controllerId,
					lastAuthenticatedAt: controller.lastAuthenticatedAt,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
			return toAccessNetworksUnleashedPublicController(
				await requireController(controller.controllerId),
			)
		},
		async request(
			request: RequestCapabilityRequest,
		): Promise<AccessNetworksUnleashedRequestResult> {
			assertWriteAllowed(request, accessNetworksUnleashedRequestConfirmation)
			if (!validActions.has(request.action)) {
				throw new Error(
					`action must be one of: ${[...validActions].join(', ')}.`,
				)
			}
			const comp = assertNonEmpty(request.comp, 'comp')
			const xmlBody = request.xmlBody
			if (typeof xmlBody !== 'string') {
				throw new Error('xmlBody must be a string of inner ajax-request XML.')
			}
			assertNotWholeWlanListWrite({
				action: request.action,
				comp,
				xmlBody,
			})
			const client = await createClient()
			const adoptedController = await requireControllerWithCredentials()
			try {
				const result = await client.request({
					action: request.action,
					comp,
					xmlBody,
					updater: request.updater,
					caller: request.caller,
					allowInsecureTls: request.allowInsecureTls,
				})
				await updateAccessNetworksUnleashedAuthStatus({
					storage,
					connectorId,
					controllerId: adoptedController.controllerId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return result
			} catch (error) {
				// Only record authentication errors against the controller. Generic
				// raw-request failures (malformed payload, unsupported component,
				// device-side command rejection) should not appear later as bad
				// credentials or a stale session.
				if (isAuthFailure(error)) {
					await updateAccessNetworksUnleashedAuthStatus({
						storage,
						connectorId,
						controllerId: adoptedController.controllerId,
						lastAuthenticatedAt: adoptedController.lastAuthenticatedAt,
						lastAuthError:
							error instanceof Error ? error.message : String(error),
					})
				}
				throw error
			}
		},
		async listWlans() {
			const client = await createClient()
			const snapshot = await fetchWlanSnapshot(client)
			return {
				wlans: snapshot.entries.map((entry) => ({
					id: entry.id,
					name: entry.name,
					ssid: entry.ssid,
					attributes: entry.attributes,
					rawXml: entry.rawXml,
				})),
				xml: snapshot.xml,
			}
		},
		async getWlan(input: { id: string }) {
			const client = await createClient()
			const { wlan, snapshot } = await getWlanById(client, input.id)
			return {
				wlan: {
					id: wlan.id,
					name: wlan.name,
					ssid: wlan.ssid,
					attributes: wlan.attributes,
					rawXml: wlan.rawXml,
				},
				wlanCount: snapshot.entries.length,
			}
		},
		async updateWlan(
			request: WriteOperationRequest & {
				id: string
				attributes: Record<string, string>
			},
		) {
			assertWriteAllowed(request, accessNetworksUnleashedWlanWriteConfirmation)
			const client = await createClient()
			return await updateWlanById({
				client,
				id: request.id,
				attributes: request.attributes,
			})
		},
		async cloneWlan(
			request: WriteOperationRequest & {
				sourceId: string
				overrides?: WlanAttributeOverrides
			},
		) {
			assertWriteAllowed(request, accessNetworksUnleashedWlanWriteConfirmation)
			const client = await createClient()
			return await cloneWlanById({
				client,
				sourceId: request.sourceId,
				overrides: request.overrides,
			})
		},
	}
}

export {
	AccessNetworksUnleashedWlanSafetyError,
	type WlanAttributeOverrides,
	type WlanRadioBand,
} from './wlan-ops.ts'
