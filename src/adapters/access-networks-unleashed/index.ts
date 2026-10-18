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
import { parseAccessNetworksUnleashedXml } from './xml.ts'
import {
	AccessNetworksUnleashedWlanWriteRefusedError,
	assertTargetedWlanWrite,
	checkWlanWriteReadiness,
	cloneWlanById,
	deleteWlanById,
	describeWlanListDamage,
	getWlanById,
	readWlanList,
	updateWlanById,
	type WlanAttributeOverrides,
} from './wlan-ops.ts'
import {
	countTopLevelWlansvcElements,
	redactSecretsInXmlText,
	redactWlanSecrets,
	xmlBodyLooksLikeFullWlanListWrite,
} from './wlan-xml.ts'

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
	AccessNetworksUnleashedRequestInput & {
		/**
		 * Escape hatch for raw `setconf` on a `*-list` component. Requires the
		 * matching `dangerousListSetconfConfirmation` phrase. Prefer addobj /
		 * updobj / delobj (and the typed WLAN tools) instead.
		 */
		allowDangerousPositionalListSetconf?: boolean
		dangerousListSetconfConfirmation?: string
	}

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
		'addobj',
		'updobj',
		'delobj',
	])

export const accessNetworksUnleashedWlanWritesDisabledMessage =
	'Access Networks Unleashed WLAN writes are disabled. On this firmware setconf on wlansvc-list always hits the FIRST WLAN (Oct 12 + Oct 17 2026 incidents), and addobj/updobj/delobj have not been validated live yet. ' +
	'Nothing was sent. Kent must explicitly enable them for a supervised test with access_networks_unleashed_set_config { wlanWritesEnabled: true } (and turn them off again afterward).'

/** Exact phrase required to unlock raw setconf on a `*-list` component. */
export const accessNetworksUnleashedDangerousListSetconfConfirmation =
	'I understand that setconf on *-list is positional on Unleashed 200.x and can overwrite the first list entry regardless of id.'

function assertWlanWritesEnabled(config: HomeConnectorConfig) {
	if (config.accessNetworksUnleashedWlanWritesEnabled !== true) {
		throw new AccessNetworksUnleashedWlanWriteRefusedError(
			accessNetworksUnleashedWlanWritesDisabledMessage,
		)
	}
}

function assertSafeRawWlanWrite(input: {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	xmlBody: string
	config: HomeConnectorConfig
	allowDangerousPositionalListSetconf?: boolean
	dangerousListSetconfConfirmation?: string
}) {
	const comp = input.comp.trim().toLowerCase()
	if (
		input.action === 'addobj' ||
		input.action === 'updobj' ||
		input.action === 'delobj'
	) {
		if (
			comp === 'wlansvc-list' ||
			countTopLevelWlansvcElements(input.xmlBody) > 0
		) {
			assertWlanWritesEnabled(input.config)
			// Same wire guard as the typed tools: explicit id or addobj create.
			assertTargetedWlanWrite(input.action, input.xmlBody)
		}
		return
	}
	if (input.action !== 'setconf') return
	if (comp.endsWith('-list')) {
		const escapeHatchArmed =
			input.allowDangerousPositionalListSetconf === true &&
			input.dangerousListSetconfConfirmation ===
				accessNetworksUnleashedDangerousListSetconfConfirmation
		if (!escapeHatchArmed) {
			throw new Error(
				`Refusing raw setconf on list component "${input.comp}". On Unleashed 200.x setconf on a *-list component is positional (it targets the first entry whatever id you send). ` +
					'Use addobj (create), updobj (by id, IS_PARTIAL), or delobj (by id) instead; for WLANs use the typed update/clone/delete_wlan tools. ' +
					'Escape hatch (HIGH RISK): set allowDangerousPositionalListSetconf=true and dangerousListSetconfConfirmation to the exact phrase documenting that you understand positional overwrite.',
			)
		}
		if (comp === 'wlansvc-list') {
			assertWlanWritesEnabled(input.config)
		}
		return
	}
	if (xmlBodyLooksLikeFullWlanListWrite(input.xmlBody)) {
		throw new Error(
			'Refusing to setconf a whole WLAN list (wlansvc-list wrapper or multiple <wlansvc> elements). ' +
				'That pattern can overwrite the first WLAN by list position and duplicate ids ' +
				'(Oct 12 friendlyguest/friendlyfamily incident). ' +
				'Use access_networks_unleashed_update_wlan, access_networks_unleashed_clone_wlan, or access_networks_unleashed_delete_wlan, ' +
				'which target a single wlansvc id, snapshot first, and roll back on unexpected diffs.',
		)
	}
	if (
		input.comp.trim().toLowerCase() === 'wlansvc-list' ||
		countTopLevelWlansvcElements(input.xmlBody) > 0
	) {
		throw new Error(
			'Refusing raw setconf of a <wlansvc> / wlansvc-list. On Unleashed 200.x a single-<wlansvc> setconf ' +
				'is applied to the FIRST WLAN in the list regardless of its id (observed Oct 12 with id="5" and ' +
				'Oct 17 with no id, both overwriting friendlyfamily). ' +
				'Use access_networks_unleashed_update_wlan (updobj by id), access_networks_unleashed_clone_wlan ' +
				'(addobj create), or access_networks_unleashed_delete_wlan (delobj by id).',
		)
	}
}

/** Strip WPA / portal secrets from any raw AJAX response before returning it. */
function redactRequestResult(
	result: AccessNetworksUnleashedRequestResult,
): AccessNetworksUnleashedRequestResult {
	const xml = redactSecretsInXmlText(result.xml)
	if (xml === result.xml) return result
	return { ...result, xml, parsed: parseAccessNetworksUnleashedXml(xml) }
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
	/** Serialize WLAN mutations so concurrent writes cannot clobber each other's snapshots. */
	let wlanWriteChain: Promise<unknown> = Promise.resolve()

	async function withWlanWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		const run = wlanWriteChain.then(operation, operation)
		wlanWriteChain = run.then(
			() => undefined,
			() => undefined,
		)
		return await run
	}

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
			assertSafeRawWlanWrite({
				action: request.action,
				comp,
				xmlBody,
				config,
				allowDangerousPositionalListSetconf:
					request.allowDangerousPositionalListSetconf,
				dangerousListSetconfConfirmation:
					request.dangerousListSetconfConfirmation,
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
				return redactRequestResult(result)
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
			// Lenient read: an id-less or duplicate entry is reported, not fatal.
			const list = await readWlanList(client)
			return {
				wlans: list.entries.map((entry) => {
					const redacted = redactWlanSecrets(entry)
					return {
						id: redacted.id,
						name: redacted.name,
						ssid: redacted.ssid,
						attributes: redacted.attributes,
						rawXml: redacted.rawXml,
					}
				}),
				// Full list xml is omitted from the tool response to avoid leaking
				// WPA secrets; use get_wlan for a single redacted entry.
				wlanCount: list.entries.length + list.anomalies.length,
				anomalies: list.anomalies.map((anomaly) => ({
					index: anomaly.index,
					kind: anomaly.kind,
					name: anomaly.name,
					ssid: anomaly.ssid,
				})),
				duplicateIds: list.duplicateIds,
				damaged: list.anomalies.length > 0 || list.duplicateIds.length > 0,
				damageSummary: describeWlanListDamage(list),
			}
		},
		async getWlan(input: { id: string }) {
			const client = await createClient()
			const { wlan, list } = await getWlanById(client, input.id)
			const redacted = redactWlanSecrets(wlan)
			return {
				wlan: {
					id: redacted.id,
					name: redacted.name,
					ssid: redacted.ssid,
					attributes: redacted.attributes,
					rawXml: redacted.rawXml,
				},
				wlanCount: list.entries.length + list.anomalies.length,
				damageSummary: describeWlanListDamage(list),
			}
		},
		async checkWlanWriteReadiness() {
			const client = await createClient()
			return await checkWlanWriteReadiness(client)
		},
		async updateWlan(
			request: WriteOperationRequest & {
				id: string
				attributes: Record<string, string>
				acceptUnrestorablePassphrases?: boolean
				dryRun?: boolean
			},
		) {
			const dryRun = request.dryRun === true
			if (!dryRun) {
				assertWriteAllowed(
					request,
					accessNetworksUnleashedWlanWriteConfirmation,
				)
				assertWlanWritesEnabled(config)
			}
			return await withWlanWriteLock(async () => {
				const client = await createClient()
				return await updateWlanById({
					client,
					id: request.id,
					attributes: request.attributes,
					acceptUnrestorablePassphrases: request.acceptUnrestorablePassphrases,
					dryRun,
				})
			})
		},
		async cloneWlan(
			request: WriteOperationRequest & {
				sourceId: string
				overrides?: WlanAttributeOverrides
				acceptUnrestorablePassphrases?: boolean
				dryRun?: boolean
			},
		) {
			const dryRun = request.dryRun === true
			if (!dryRun) {
				assertWriteAllowed(
					request,
					accessNetworksUnleashedWlanWriteConfirmation,
				)
				assertWlanWritesEnabled(config)
			}
			return await withWlanWriteLock(async () => {
				const client = await createClient()
				return await cloneWlanById({
					client,
					sourceId: request.sourceId,
					overrides: request.overrides,
					acceptUnrestorablePassphrases: request.acceptUnrestorablePassphrases,
					dryRun,
				})
			})
		},
		async deleteWlan(
			request: WriteOperationRequest & {
				id: string
				expectedName: string
				acceptUnrestorablePassphrases?: boolean
				dryRun?: boolean
			},
		) {
			const dryRun = request.dryRun === true
			if (!dryRun) {
				assertWriteAllowed(
					request,
					accessNetworksUnleashedWlanWriteConfirmation,
				)
				assertWlanWritesEnabled(config)
			}
			return await withWlanWriteLock(async () => {
				const client = await createClient()
				return await deleteWlanById({
					client,
					id: request.id,
					expectedName: request.expectedName,
					acceptUnrestorablePassphrases: request.acceptUnrestorablePassphrases,
					dryRun,
				})
			})
		},
	}
}

export {
	AccessNetworksUnleashedWlanSafetyError,
	AccessNetworksUnleashedWlanWriteRefusedError,
	type WlanAttributeOverrides,
	type WlanRadioBand,
} from './wlan-ops.ts'
