import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createKasaKlapClient } from './klap-client.ts'
import {
	createKasaKlapSubprocessClient,
	shouldUseKasaKlapSubprocessClient,
} from './klap-subprocess-client.ts'
import { scanKasaPlugs } from './discovery.ts'
import {
	adoptKasaPlug,
	getKasaCredentials,
	getKasaPlug,
	listKasaPlugs,
	removeKasaPlug,
	saveKasaCredentials,
	toKasaPublicPlug,
	updateKasaAuthStatus,
	updateKasaPlugSysinfo,
	upsertDiscoveredKasaPlugs,
} from './repository.ts'
import {
	type KasaClient,
	type KasaClientCredentials,
	type KasaDiscoveredPlug,
	type KasaDiscoveryDiagnostics,
	type KasaPersistedPlug,
	type KasaPlugSelector,
	type KasaSysInfo,
} from './types.ts'
import { kasaRelayStateFromSysinfo } from './klap-client.ts'

type KasaClientFactory = (input: {
	plug: KasaPersistedPlug
	credentials: KasaClientCredentials
}) => KasaClient

type KasaScanFunction = () => Promise<{
	plugs: Array<KasaDiscoveredPlug>
	diagnostics: KasaDiscoveryDiagnostics
}>

type KasaPlugSelectionErrorCode =
	| 'kasa_plug_not_found'
	| 'kasa_plug_alias_not_found'
	| 'kasa_plug_alias_ambiguous'
	| 'kasa_plug_selector_invalid'

export class KasaPlugSelectionError extends Error {
	readonly code: KasaPlugSelectionErrorCode
	readonly plugId: string | undefined
	readonly alias: string | undefined
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext

	constructor(input: {
		code: KasaPlugSelectionErrorCode
		message: string
		plugId?: string
		alias?: string
	}) {
		super(input.message)
		this.name = 'KasaPlugSelectionError'
		this.code = input.code
		this.plugId = input.plugId
		this.alias = input.alias
		this.homeConnectorCaptureContext = {
			shouldCapture: false,
			tags: {
				connector_vendor: 'kasa',
				kasa_selection_error: input.code,
			},
		}
	}
}

export function isKasaPlugSelectionError(
	error: unknown,
): error is KasaPlugSelectionError {
	return error instanceof KasaPlugSelectionError
}

function assertNonEmpty(value: string, field: string) {
	const trimmed = value.trim()
	if (!trimmed) throw new Error(`${field} must not be empty.`)
	return trimmed
}

function normalizeAlias(value: string) {
	return value.trim().toLowerCase()
}

function isAuthFailure(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /\b(rejected the configured TP-Link credentials|credentials|handshake1|handshake2|TP_SESSIONID)\b/i.test(
		message,
	)
}

function isRetriableKasaTransportError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /KLAP handshake1|signature did not match|timed out|security error|responded with 0|did not return device info|subprocess timed out|subprocess produced no output/i.test(
		message,
	)
}

function isKasaTransientNetworkError(error: unknown) {
	const message = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase()
	return (
		message.includes('ehostunreach') ||
		message.includes('enetunreach') ||
		message.includes('econnrefused') ||
		message.includes('econnreset') ||
		message.includes('etimedout') ||
		message.includes('enotfound') ||
		message.includes('eai_again') ||
		message.includes('subprocess timed out') ||
		message.includes('kasa klap subprocess timed out')
	)
}

function annotateKasaTransientNetworkError(error: unknown) {
	if (!isKasaTransientNetworkError(error) || !(error instanceof Error)) {
		return error
	}
	const annotated = error as Error & {
		homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext
	}
	annotated.homeConnectorCaptureContext = {
		...annotated.homeConnectorCaptureContext,
		shouldCapture: false,
		tags: {
			...annotated.homeConnectorCaptureContext?.tags,
			connector_vendor: 'kasa',
			kasa_failure_class: 'transient_network',
		},
	}
	return annotated
}

function getEnvCredentials(config: HomeConnectorConfig) {
	if (!config.kasaUsername || !config.kasaPassword) return null
	return {
		username: config.kasaUsername,
		password: config.kasaPassword,
		lastAuthenticatedAt: null,
		lastAuthError: null,
		source: 'env' as const,
	}
}

function mapStatusResult(input: {
	plug: KasaPersistedPlug
	sysinfo: KasaSysInfo
}) {
	return {
		plug: input.plug,
		sysinfo: input.sysinfo,
		relayState: kasaRelayStateFromSysinfo(input.sysinfo),
	}
}

function getNestedNumber(value: unknown, path: Array<string>) {
	let current = value
	for (const key of path) {
		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			return null
		}
		current = (current as Record<string, unknown>)[key]
	}
	return typeof current === 'number' ? current : null
}

function getRelaySetErrorCode(response: Record<string, unknown>) {
	return (
		getNestedNumber(response, ['system', 'set_relay_state', 'err_code']) ??
		getNestedNumber(response, [
			'result',
			'system',
			'set_relay_state',
			'err_code',
		])
	)
}

export function createKasaAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
	clientFactory?: KasaClientFactory
	scanPlugs?: KasaScanFunction
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId

	async function getCredentials() {
		return (
			(await getKasaCredentials(storage, connectorId)) ??
			getEnvCredentials(config)
		)
	}

	async function getConfigStatus() {
		const credentials = await getCredentials()
		return {
			configured: Boolean(credentials),
			hasStoredCredentials: Boolean(
				await getKasaCredentials(storage, connectorId),
			),
			hasEnvCredentials: Boolean(getEnvCredentials(config)),
			credentialSource: credentials?.source ?? null,
			username: credentials?.username ?? null,
			missingRequirements: credentials ? [] : ['credentials'],
			lastAuthenticatedAt: credentials?.lastAuthenticatedAt ?? null,
			lastAuthError: credentials?.lastAuthError ?? null,
		}
	}

	async function requireCredentials() {
		const credentials = await getCredentials()
		if (!credentials) {
			throw new Error(
				'Kasa credentials are missing. Set KASA_USERNAME/KASA_PASSWORD or call kasa_set_credentials first.',
			)
		}
		return credentials
	}

	async function listPlugs() {
		const credentials = await getCredentials()
		return (await listKasaPlugs(storage, connectorId)).map((plug) =>
			toKasaPublicPlug(plug, credentials),
		)
	}

	async function requirePlug(plugId: string) {
		const plug = await getKasaPlug(storage, connectorId, plugId)
		if (!plug) {
			throw new KasaPlugSelectionError({
				code: 'kasa_plug_not_found',
				message: `Kasa plug "${plugId}" was not found.`,
				plugId,
			})
		}
		return plug
	}

	async function resolvePlug(selector: KasaPlugSelector) {
		const hasPlugId = Boolean(selector.plugId?.trim())
		const hasAlias = Boolean(selector.alias?.trim())
		if (hasPlugId === hasAlias) {
			throw new KasaPlugSelectionError({
				code: 'kasa_plug_selector_invalid',
				message: 'Provide exactly one of plugId or alias.',
			})
		}
		if (hasPlugId) return requirePlug(selector.plugId!.trim())
		const alias = selector.alias!.trim()
		const matches = (await listKasaPlugs(storage, connectorId)).filter(
			(plug) => normalizeAlias(plug.alias) === normalizeAlias(alias),
		)
		if (matches.length === 0) {
			throw new KasaPlugSelectionError({
				code: 'kasa_plug_alias_not_found',
				message: `Kasa plug alias "${alias}" was not found.`,
				alias,
			})
		}
		if (matches.length > 1) {
			throw new KasaPlugSelectionError({
				code: 'kasa_plug_alias_ambiguous',
				message: `Kasa plug alias "${alias}" is ambiguous. Use a plugId instead.`,
				alias,
			})
		}
		return matches[0]!
	}

	async function requireAdoptedPlug(selector: KasaPlugSelector) {
		const plug = await resolvePlug(selector)
		if (!plug.adopted) {
			throw new Error(
				`Kasa plug "${plug.alias}" is not adopted. Run kasa_adopt_plug before controlling it.`,
			)
		}
		return plug
	}

	async function createClient(plug: KasaPersistedPlug) {
		const credentials = await requireCredentials()
		if (input.clientFactory) {
			return input.clientFactory({ plug, credentials })
		}
		const clientInput = {
			host: plug.host,
			port: plug.port,
			credentials,
			timeoutMs: config.kasaRequestTimeoutMs,
		}
		if (shouldUseKasaKlapSubprocessClient()) {
			return createKasaKlapSubprocessClient(clientInput)
		}
		return createKasaKlapClient(clientInput)
	}

	async function updateSuccessfulAuth(client: KasaClient) {
		if (
			(await getKasaCredentials(storage, connectorId)) &&
			client.usedConfiguredCredentials !== false
		) {
			await updateKasaAuthStatus({
				storage,
				connectorId,
				lastAuthenticatedAt: new Date().toISOString(),
				lastAuthError: null,
			})
		}
	}

	async function updateFailedAuth(error: unknown) {
		const credentials = await getKasaCredentials(storage, connectorId)
		if (!credentials || !isAuthFailure(error)) return
		await updateKasaAuthStatus({
			storage,
			connectorId,
			lastAuthenticatedAt: credentials.lastAuthenticatedAt ?? null,
			lastAuthError: error instanceof Error ? error.message : String(error),
		})
	}

	async function getLiveStatus(selector: KasaPlugSelector) {
		const plug = await resolvePlug(selector)
		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			const client = await createClient(plug)
			try {
				const sysinfo = await client.getSysInfo()
				await updateSuccessfulAuth(client)
				const relayState = kasaRelayStateFromSysinfo(sysinfo)
				const updated =
					(await updateKasaPlugSysinfo({
						storage,
						connectorId,
						plugId: plug.plugId,
						relayState,
						rawSysinfo: sysinfo,
						lastSeenAt: new Date().toISOString(),
					})) ?? plug
				return mapStatusResult({ plug: updated, sysinfo })
			} catch (error) {
				lastError = error
				if (attempt === 0 && isRetriableKasaTransportError(error)) {
					continue
				}
				await updateFailedAuth(error)
				throw annotateKasaTransientNetworkError(error)
			}
		}
		await updateFailedAuth(lastError)
		throw annotateKasaTransientNetworkError(lastError)
	}

	async function setRelayState(selector: KasaPlugSelector, state: boolean) {
		const plug = await requireAdoptedPlug(selector)
		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			const client = await createClient(plug)
			try {
				const response = await client.setRelayState(state)
				const errCode = getRelaySetErrorCode(response)
				if (errCode != null && errCode !== 0) {
					throw new Error(
						`Kasa plug "${plug.alias}" rejected relay update with err_code ${String(errCode)}.`,
					)
				}
				const sysinfo = await client.getSysInfo()
				await updateSuccessfulAuth(client)
				const relayState = kasaRelayStateFromSysinfo(sysinfo)
				const requestedRelayState = state ? 'on' : 'off'
				if (relayState !== requestedRelayState) {
					throw new Error(
						`Kasa plug "${plug.alias}" did not report relay state ${requestedRelayState} after control; current state is ${relayState}.`,
					)
				}
				const updated =
					(await updateKasaPlugSysinfo({
						storage,
						connectorId,
						plugId: plug.plugId,
						relayState,
						rawSysinfo: sysinfo,
						lastSeenAt: new Date().toISOString(),
					})) ?? plug
				return {
					plug: updated,
					requestedRelayState,
					relayState,
					response,
					sysinfo,
				}
			} catch (error) {
				lastError = error
				if (attempt === 0 && isRetriableKasaTransportError(error)) {
					continue
				}
				await updateFailedAuth(error)
				throw annotateKasaTransientNetworkError(error)
			}
		}
		await updateFailedAuth(lastError)
		throw annotateKasaTransientNetworkError(lastError)
	}

	return {
		getConfigStatus,
		getDiscoveryDiagnostics() {
			return state.kasaDiscoveryDiagnostics
		},
		listPlugs,
		async getStatus() {
			const plugs = await listPlugs()
			return {
				config: await getConfigStatus(),
				plugs,
				adopted: plugs.filter((plug) => plug.adopted),
				discovered: plugs.filter((plug) => !plug.adopted),
				diagnostics: state.kasaDiscoveryDiagnostics,
			}
		},
		async scan() {
			const credentials = await getCredentials()
			const result =
				input.scanPlugs != null
					? await input.scanPlugs()
					: await scanKasaPlugs({
							state,
							config,
							credentials,
							clientFactory: ({ host, port, credentials }) =>
								createKasaKlapClient({
									host,
									port,
									credentials,
									timeoutMs: config.kasaRequestTimeoutMs,
								}),
						})
			state.kasaDiscoveryDiagnostics = result.diagnostics
			await upsertDiscoveredKasaPlugs(storage, connectorId, result.plugs)
			return listPlugs()
		},
		async adoptPlug(selector: KasaPlugSelector) {
			const plug = await resolvePlug(selector)
			const adopted = await adoptKasaPlug(storage, connectorId, plug.plugId)
			if (!adopted) throw new Error(`Kasa plug "${plug.plugId}" was not found.`)
			return toKasaPublicPlug(adopted, await getCredentials())
		},
		async forgetPlug(selector: KasaPlugSelector) {
			const plug = await resolvePlug(selector)
			await removeKasaPlug({ storage, connectorId, plugId: plug.plugId })
			return toKasaPublicPlug(plug, await getCredentials())
		},
		async setCredentials(username: string, password: string) {
			const credentials = await saveKasaCredentials({
				storage,
				connectorId,
				username: assertNonEmpty(username, 'username'),
				password: assertNonEmpty(password, 'password'),
			})
			return {
				configured: Boolean(credentials),
				hasStoredCredentials: Boolean(credentials),
				credentialSource: credentials?.source ?? null,
				lastAuthenticatedAt: credentials?.lastAuthenticatedAt ?? null,
				lastAuthError: credentials?.lastAuthError ?? null,
			}
		},
		getPlugStatus: getLiveStatus,
		async turnOn(selector: KasaPlugSelector) {
			return await setRelayState(selector, true)
		},
		async turnOff(selector: KasaPlugSelector) {
			return await setRelayState(selector, false)
		},
	}
}
