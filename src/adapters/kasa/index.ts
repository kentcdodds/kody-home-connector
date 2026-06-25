import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createKasaKlapClient } from './klap-client.ts'
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
	return /KLAP handshake1|signature did not match|timed out|security error|responded with 0/i.test(
		message,
	)
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

	function getCredentials() {
		return getKasaCredentials(storage, connectorId) ?? getEnvCredentials(config)
	}

	function getConfigStatus() {
		const credentials = getCredentials()
		return {
			configured: Boolean(credentials),
			hasStoredCredentials: Boolean(getKasaCredentials(storage, connectorId)),
			hasEnvCredentials: Boolean(getEnvCredentials(config)),
			credentialSource: credentials?.source ?? null,
			username: credentials?.username ?? null,
			missingRequirements: credentials ? [] : ['credentials'],
			lastAuthenticatedAt: credentials?.lastAuthenticatedAt ?? null,
			lastAuthError: credentials?.lastAuthError ?? null,
		}
	}

	function requireCredentials() {
		const credentials = getCredentials()
		if (!credentials) {
			throw new Error(
				'Kasa credentials are missing. Set KASA_USERNAME/KASA_PASSWORD or call kasa_set_credentials first.',
			)
		}
		return credentials
	}

	function listPlugs() {
		const credentials = getCredentials()
		return listKasaPlugs(storage, connectorId).map((plug) =>
			toKasaPublicPlug(plug, credentials),
		)
	}

	function requirePlug(plugId: string) {
		const plug = getKasaPlug(storage, connectorId, plugId)
		if (!plug) throw new Error(`Kasa plug "${plugId}" was not found.`)
		return plug
	}

	function resolvePlug(selector: KasaPlugSelector) {
		const hasPlugId = Boolean(selector.plugId?.trim())
		const hasAlias = Boolean(selector.alias?.trim())
		if (hasPlugId === hasAlias) {
			throw new Error('Provide exactly one of plugId or alias.')
		}
		if (hasPlugId) return requirePlug(selector.plugId!.trim())
		const alias = selector.alias!.trim()
		const matches = listKasaPlugs(storage, connectorId).filter(
			(plug) => normalizeAlias(plug.alias) === normalizeAlias(alias),
		)
		if (matches.length === 0) {
			throw new Error(`Kasa plug alias "${alias}" was not found.`)
		}
		if (matches.length > 1) {
			throw new Error(
				`Kasa plug alias "${alias}" is ambiguous. Use a plugId instead.`,
			)
		}
		return matches[0]!
	}

	function requireAdoptedPlug(selector: KasaPlugSelector) {
		const plug = resolvePlug(selector)
		if (!plug.adopted) {
			throw new Error(
				`Kasa plug "${plug.alias}" is not adopted. Run kasa_adopt_plug before controlling it.`,
			)
		}
		return plug
	}

	function createClient(plug: KasaPersistedPlug) {
		const credentials = requireCredentials()
		return (
			input.clientFactory?.({ plug, credentials }) ??
			createKasaKlapClient({
				host: plug.host,
				port: plug.port,
				credentials,
				timeoutMs: config.kasaRequestTimeoutMs,
			})
		)
	}

	function updateSuccessfulAuth(client: KasaClient) {
		if (
			getKasaCredentials(storage, connectorId) &&
			client.usedConfiguredCredentials !== false
		) {
			updateKasaAuthStatus({
				storage,
				connectorId,
				lastAuthenticatedAt: new Date().toISOString(),
				lastAuthError: null,
			})
		}
	}

	function updateFailedAuth(error: unknown) {
		if (!getKasaCredentials(storage, connectorId) || !isAuthFailure(error))
			return
		updateKasaAuthStatus({
			storage,
			connectorId,
			lastAuthenticatedAt:
				getKasaCredentials(storage, connectorId)?.lastAuthenticatedAt ?? null,
			lastAuthError: error instanceof Error ? error.message : String(error),
		})
	}

	async function getLiveStatus(selector: KasaPlugSelector) {
		const plug = resolvePlug(selector)
		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			const client = createClient(plug)
			try {
				const sysinfo = await client.getSysInfo()
				updateSuccessfulAuth(client)
				const relayState = kasaRelayStateFromSysinfo(sysinfo)
				const updated =
					updateKasaPlugSysinfo({
						storage,
						connectorId,
						plugId: plug.plugId,
						relayState,
						rawSysinfo: sysinfo,
						lastSeenAt: new Date().toISOString(),
					}) ?? plug
				return mapStatusResult({ plug: updated, sysinfo })
			} catch (error) {
				lastError = error
				if (attempt === 0 && isRetriableKasaTransportError(error)) {
					continue
				}
				updateFailedAuth(error)
				throw error
			}
		}
		updateFailedAuth(lastError)
		throw lastError
	}

	async function setRelayState(selector: KasaPlugSelector, state: boolean) {
		const plug = requireAdoptedPlug(selector)
		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			const client = createClient(plug)
			try {
				const response = await client.setRelayState(state)
				const errCode = getRelaySetErrorCode(response)
				if (errCode != null && errCode !== 0) {
					throw new Error(
						`Kasa plug "${plug.alias}" rejected relay update with err_code ${String(errCode)}.`,
					)
				}
				const sysinfo = await client.getSysInfo()
				updateSuccessfulAuth(client)
				const relayState = kasaRelayStateFromSysinfo(sysinfo)
				const requestedRelayState = state ? 'on' : 'off'
				if (relayState !== requestedRelayState) {
					throw new Error(
						`Kasa plug "${plug.alias}" did not report relay state ${requestedRelayState} after control; current state is ${relayState}.`,
					)
				}
				const updated =
					updateKasaPlugSysinfo({
						storage,
						connectorId,
						plugId: plug.plugId,
						relayState,
						rawSysinfo: sysinfo,
						lastSeenAt: new Date().toISOString(),
					}) ?? plug
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
				updateFailedAuth(error)
				throw error
			}
		}
		updateFailedAuth(lastError)
		throw lastError
	}

	return {
		getConfigStatus,
		getDiscoveryDiagnostics() {
			return state.kasaDiscoveryDiagnostics
		},
		listPlugs,
		getStatus() {
			const plugs = listPlugs()
			return {
				config: getConfigStatus(),
				plugs,
				adopted: plugs.filter((plug) => plug.adopted),
				discovered: plugs.filter((plug) => !plug.adopted),
				diagnostics: state.kasaDiscoveryDiagnostics,
			}
		},
		async scan() {
			const credentials = getCredentials()
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
			upsertDiscoveredKasaPlugs(storage, connectorId, result.plugs)
			return listPlugs()
		},
		adoptPlug(selector: KasaPlugSelector) {
			const plug = resolvePlug(selector)
			const adopted = adoptKasaPlug(storage, connectorId, plug.plugId)
			if (!adopted) throw new Error(`Kasa plug "${plug.plugId}" was not found.`)
			return toKasaPublicPlug(adopted, getCredentials())
		},
		forgetPlug(selector: KasaPlugSelector) {
			const plug = resolvePlug(selector)
			removeKasaPlug({ storage, connectorId, plugId: plug.plugId })
			return toKasaPublicPlug(plug, getCredentials())
		},
		setCredentials(username: string, password: string) {
			const credentials = saveKasaCredentials({
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
