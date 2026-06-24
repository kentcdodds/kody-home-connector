import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createKasaLegacyClient } from './client.ts'
import { scanKasaPlugs, summarizeKasaSysInfo } from './discovery.ts'
import {
	adoptKasaPlug,
	getKasaPlug,
	listKasaPlugs,
	removeKasaPlug,
	toKasaPublicPlug,
	updateKasaPlugConnection,
	upsertDiscoveredKasaPlugs,
} from './repository.ts'
import {
	type KasaClient,
	type KasaDiscoveredPlug,
	type KasaPersistedPlug,
	type KasaRelayState,
} from './types.ts'

function normalizeIdentifier(value: string) {
	return value.trim().toLowerCase()
}

function plugLabel(plug: KasaPersistedPlug) {
	return `${plug.alias} (${plug.plugId})`
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

export function createKasaAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
	client?: KasaClient
	scanPlugs?: () => Promise<{
		plugs: Array<KasaDiscoveredPlug>
		diagnostics: HomeConnectorState['kasaDiscoveryDiagnostics']
	}>
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId
	const client = input.client ?? createKasaLegacyClient()

	function getPublicPlugs() {
		return listKasaPlugs(storage, connectorId).map(toKasaPublicPlug)
	}

	function requirePlug(plugId: string) {
		const plug = getKasaPlug(storage, connectorId, plugId)
		if (!plug) {
			throw new Error(`Kasa plug "${plugId}" was not found.`)
		}
		return plug
	}

	function resolvePlug(identifier?: string) {
		const plugs = listKasaPlugs(storage, connectorId)
		if (!identifier) {
			const adopted = plugs.filter((plug) => plug.adopted)
			if (adopted.length === 1) return adopted[0]!
			if (adopted.length > 1) {
				throw new Error(
					`Multiple adopted Kasa plugs are available: ${adopted.map(plugLabel).join('; ')}. Provide a plugId or alias.`,
				)
			}
			if (plugs.length === 1) return plugs[0]!
			if (plugs.length > 1) {
				throw new Error(
					`Multiple Kasa plugs are known: ${plugs.map(plugLabel).join('; ')}. Provide a plugId or alias.`,
				)
			}
			throw new Error(
				'No Kasa plugs are currently known. Run kasa_scan_plugs first.',
			)
		}

		const normalized = normalizeIdentifier(identifier)
		const exact =
			plugs.find((plug) => normalizeIdentifier(plug.plugId) === normalized) ??
			plugs.find((plug) => normalizeIdentifier(plug.alias) === normalized)
		if (exact) return exact

		const partial = plugs.filter((plug) =>
			normalizeIdentifier(plug.alias).includes(normalized),
		)
		if (partial.length === 1) return partial[0]!
		if (partial.length > 1) {
			throw new Error(
				`Multiple Kasa plugs matched "${identifier}": ${partial.map(plugLabel).join('; ')}. Provide plugId.`,
			)
		}
		throw new Error(`Kasa plug "${identifier}" was not found.`)
	}

	function requireAdoptedPlug(identifier?: string) {
		const plug = resolvePlug(identifier)
		if (!plug.adopted) {
			throw new Error(
				`Kasa plug "${plug.plugId}" must be adopted before control.`,
			)
		}
		return plug
	}

	function recordPlugConnection(inputRecord: {
		plug: KasaPersistedPlug
		sysInfo: Record<string, unknown>
		lastConnectedAt: string | null
		lastError: string | null
	}) {
		const summarized = summarizeKasaSysInfo({
			host: inputRecord.plug.host,
			port: inputRecord.plug.port,
			sysInfo: inputRecord.sysInfo,
			now: new Date().toISOString(),
		})
		return (
			updateKasaPlugConnection({
				storage,
				connectorId,
				plugId: inputRecord.plug.plugId,
				host: summarized.host,
				port: summarized.port,
				relayState: summarized.relayState,
				ledOff: summarized.ledOff,
				onTime: summarized.onTime,
				rawSysInfo: summarized.rawSysInfo,
				lastSeenAt: summarized.lastSeenAt,
				lastConnectedAt: inputRecord.lastConnectedAt,
				lastError: inputRecord.lastError,
			}) ?? inputRecord.plug
		)
	}

	async function readPlugStatus(plug: KasaPersistedPlug) {
		try {
			const sysInfo = await client.getSysInfo({
				host: plug.host,
				port: plug.port,
				timeoutMs: config.kasaRequestTimeoutMs,
			})
			const now = new Date().toISOString()
			const updated = recordPlugConnection({
				plug,
				sysInfo,
				lastConnectedAt: now,
				lastError: null,
			})
			return {
				plug: updated,
				sysInfo,
				online: true,
			}
		} catch (error) {
			updateKasaPlugConnection({
				storage,
				connectorId,
				plugId: plug.plugId,
				host: plug.host,
				port: plug.port,
				relayState: plug.relayState,
				ledOff: plug.ledOff,
				onTime: plug.onTime,
				rawSysInfo: plug.rawSysInfo,
				lastSeenAt: plug.lastSeenAt,
				lastConnectedAt: plug.lastConnectedAt,
				lastError: getErrorMessage(error),
			})
			throw new Error(
				`Kasa plug "${plug.plugId}" could not be reached at ${plug.host}:${String(plug.port)}. ${getErrorMessage(error)}`,
			)
		}
	}

	function recordUnconfirmedRelayState(inputRecord: {
		plug: KasaPersistedPlug
		state: KasaRelayState
		statusReadError: string
	}) {
		const now = new Date().toISOString()
		return (
			updateKasaPlugConnection({
				storage,
				connectorId,
				plugId: inputRecord.plug.plugId,
				host: inputRecord.plug.host,
				port: inputRecord.plug.port,
				relayState: inputRecord.state,
				ledOff: inputRecord.plug.ledOff,
				onTime: inputRecord.plug.onTime,
				rawSysInfo: {
					...inputRecord.plug.rawSysInfo,
					relay_state: inputRecord.state,
				},
				lastSeenAt: now,
				lastConnectedAt: now,
				lastError: `Relay state write succeeded, but follow-up status read failed: ${inputRecord.statusReadError}`,
			}) ?? {
				...inputRecord.plug,
				relayState: inputRecord.state,
				lastSeenAt: now,
				lastConnectedAt: now,
				lastError: inputRecord.statusReadError,
				rawSysInfo: {
					...inputRecord.plug.rawSysInfo,
					relay_state: inputRecord.state,
				},
			}
		)
	}

	async function setPlugRelayState(inputSet: {
		identifier?: string
		state: KasaRelayState
	}) {
		const plug = requireAdoptedPlug(inputSet.identifier)
		const response = await client.setRelayState({
			host: plug.host,
			port: plug.port,
			state: inputSet.state,
			timeoutMs: config.kasaRequestTimeoutMs,
		})
		try {
			const status = await readPlugStatus(plug)
			return {
				plug: status.plug,
				requestedState: inputSet.state,
				response,
				status,
				confirmed: true,
				statusReadError: null,
			}
		} catch (error) {
			const statusReadError = getErrorMessage(error)
			const updated = recordUnconfirmedRelayState({
				plug,
				state: inputSet.state,
				statusReadError,
			})
			return {
				plug: updated,
				requestedState: inputSet.state,
				response,
				status: null,
				confirmed: false,
				statusReadError,
			}
		}
	}

	return {
		async scan() {
			const result = input.scanPlugs
				? await input.scanPlugs()
				: await scanKasaPlugs(state, config, client)
			if (input.scanPlugs) {
				state.kasaDiscoveredPlugs = [...result.plugs]
				state.kasaDiscoveryDiagnostics = result.diagnostics
			}
			upsertDiscoveredKasaPlugs({
				storage,
				connectorId,
				plugs: result.plugs,
			})
			return getPublicPlugs()
		},
		getStatus() {
			const plugs = getPublicPlugs()
			return {
				plugs,
				adopted: plugs.filter((plug) => plug.adopted),
				discovered: plugs.filter((plug) => !plug.adopted),
				lastScanDiscovered: state.kasaDiscoveredPlugs,
				diagnostics: state.kasaDiscoveryDiagnostics,
			}
		},
		listPlugs() {
			return getPublicPlugs()
		},
		adoptPlug(plugId: string) {
			requirePlug(plugId)
			const plug = adoptKasaPlug({ storage, connectorId, plugId })
			if (!plug) {
				throw new Error(`Kasa plug "${plugId}" could not be adopted.`)
			}
			return toKasaPublicPlug(plug)
		},
		forgetPlug(plugId: string) {
			const plug = requirePlug(plugId)
			removeKasaPlug({ storage, connectorId, plugId })
			return toKasaPublicPlug(plug)
		},
		async getPlugStatus(identifier?: string) {
			return await readPlugStatus(resolvePlug(identifier))
		},
		async turnPlugOn(identifier?: string) {
			return await setPlugRelayState({ identifier, state: 1 })
		},
		async turnPlugOff(identifier?: string) {
			return await setPlugRelayState({ identifier, state: 0 })
		},
	}
}
