import {
	type RokuDeviceRecord,
	type RokuDiscoveryDiagnostics,
} from './adapters/roku/types.ts'
import { type LutronDiscoveryDiagnostics } from './adapters/lutron/types.ts'
import { type SamsungTvDiscoveryDiagnostics } from './adapters/samsung-tv/types.ts'
import { type BondDiscoveryDiagnostics } from './adapters/bond/types.ts'
import {
	type JellyfishDiscoveredController,
	type JellyfishDiscoveryDiagnostics,
} from './adapters/jellyfish/types.ts'
import { type SonosDiscoveryDiagnostics } from './adapters/sonos/types.ts'
import {
	type VenstarDiscoveredThermostat,
	type VenstarDiscoveryDiagnostics,
} from './adapters/venstar/types.ts'
import { type AccessNetworksUnleashedDiscoveryDiagnostics } from './adapters/access-networks-unleashed/types.ts'
import { type KasaDiscoveryDiagnostics } from './adapters/kasa/types.ts'

export type HomeConnectorToolInventoryStatus =
	| 'not_connected'
	| 'pending_remote_list'
	| 'refresh_requested'
	| 'registered'
	| 'empty_local_registry'
	| 'remote_list_missing'
	| 'reconnecting_after_missing_remote_list'

export type HomeConnectorConnectionState = {
	workerUrl: string
	connectorId: string
	/**
	 * Kody account username for this Worker session, when username-scoped.
	 */
	kodyUsername: string | null
	connected: boolean
	lastSyncAt: string | null
	lastError: string | null
	sharedSecret: string | null
	mocksEnabled: boolean
	localToolCount: number
	toolInventoryStatus: HomeConnectorToolInventoryStatus
	toolInventoryStatusReason: string
	lastToolsChangedNotificationAt: string | null
	lastToolsListRequestAt: string | null
	toolInventoryRecoveryCount: number
}

/**
 * Per-target Worker session status. `state.connection` mirrors the primary
 * (first) session for backward-compatible admin pages.
 */
export type HomeConnectorWorkerSessionState = HomeConnectorConnectionState & {
	sessionKey: string
	workerSessionUrl: string
	workerWebSocketUrl: string
}

export type HomeConnectorState = {
	connection: HomeConnectorConnectionState
	workerSessions: Array<HomeConnectorWorkerSessionState>
	devices: Array<RokuDeviceRecord>
	rokuDiscoveryDiagnostics: RokuDiscoveryDiagnostics | null
	samsungTvDiscoveryDiagnostics: SamsungTvDiscoveryDiagnostics | null
	lutronDiscoveryDiagnostics: LutronDiscoveryDiagnostics | null
	sonosDiscoveryDiagnostics: SonosDiscoveryDiagnostics | null
	bondDiscoveryDiagnostics: BondDiscoveryDiagnostics | null
	jellyfishDiscoveryDiagnostics: JellyfishDiscoveryDiagnostics | null
	jellyfishDiscoveredControllers: Array<JellyfishDiscoveredController>
	venstarDiscoveryDiagnostics: VenstarDiscoveryDiagnostics | null
	venstarDiscoveredThermostats: Array<VenstarDiscoveredThermostat>
	accessNetworksUnleashedDiscoveryDiagnostics: AccessNetworksUnleashedDiscoveryDiagnostics | null
	kasaDiscoveryDiagnostics: KasaDiscoveryDiagnostics | null
}

const initialConnectionState: HomeConnectorConnectionState = {
	workerUrl: '',
	connectorId: '',
	kodyUsername: null,
	connected: false,
	lastSyncAt: null,
	lastError: null,
	sharedSecret: null,
	mocksEnabled: false,
	localToolCount: 0,
	toolInventoryStatus: 'not_connected',
	toolInventoryStatusReason: 'Worker transport is not connected yet.',
	lastToolsChangedNotificationAt: null,
	lastToolsListRequestAt: null,
	toolInventoryRecoveryCount: 0,
}

const initialState: HomeConnectorState = {
	connection: structuredClone(initialConnectionState),
	workerSessions: [],
	devices: [],
	rokuDiscoveryDiagnostics: null,
	samsungTvDiscoveryDiagnostics: null,
	lutronDiscoveryDiagnostics: null,
	sonosDiscoveryDiagnostics: null,
	bondDiscoveryDiagnostics: null,
	jellyfishDiscoveryDiagnostics: null,
	jellyfishDiscoveredControllers: [],
	venstarDiscoveryDiagnostics: null,
	venstarDiscoveredThermostats: [],
	accessNetworksUnleashedDiscoveryDiagnostics: null,
	kasaDiscoveryDiagnostics: null,
}

export function createAppState(): HomeConnectorState {
	return structuredClone(initialState)
}

export function createWorkerSessionKey(input: {
	kodyUsername: string | null
	homeConnectorId: string
}) {
	const username = input.kodyUsername?.trim() || 'local'
	return `${username}/${input.homeConnectorId}`
}

export function updateConnectionState(
	state: HomeConnectorState,
	input: Partial<HomeConnectorConnectionState>,
) {
	state.connection = {
		...state.connection,
		...input,
	}
	return state.connection
}

export function initializeWorkerSessionStates(
	state: HomeConnectorState,
	sessions: Array<{
		kodyUsername: string | null
		homeConnectorId: string
		workerBaseUrl: string
		workerSessionUrl: string
		workerWebSocketUrl: string
		sharedSecret: string | null
		mocksEnabled: boolean
	}>,
) {
	state.workerSessions = sessions.map((session) => ({
		...structuredClone(initialConnectionState),
		sessionKey: createWorkerSessionKey({
			kodyUsername: session.kodyUsername,
			homeConnectorId: session.homeConnectorId,
		}),
		workerUrl: session.workerBaseUrl,
		connectorId: session.homeConnectorId,
		kodyUsername: session.kodyUsername,
		sharedSecret: session.sharedSecret,
		mocksEnabled: session.mocksEnabled,
		workerSessionUrl: session.workerSessionUrl,
		workerWebSocketUrl: session.workerWebSocketUrl,
	}))
	const primary = state.workerSessions[0]
	if (primary) {
		updateConnectionState(state, {
			workerUrl: primary.workerUrl,
			connectorId: primary.connectorId,
			kodyUsername: primary.kodyUsername,
			sharedSecret: primary.sharedSecret,
			mocksEnabled: primary.mocksEnabled,
			connected: primary.connected,
			lastSyncAt: primary.lastSyncAt,
			lastError: primary.lastError,
			localToolCount: primary.localToolCount,
			toolInventoryStatus: primary.toolInventoryStatus,
			toolInventoryStatusReason: primary.toolInventoryStatusReason,
			lastToolsChangedNotificationAt: primary.lastToolsChangedNotificationAt,
			lastToolsListRequestAt: primary.lastToolsListRequestAt,
			toolInventoryRecoveryCount: primary.toolInventoryRecoveryCount,
		})
	}
	return state.workerSessions
}

export function updateWorkerSessionState(
	state: HomeConnectorState,
	sessionIndex: number,
	input: Partial<HomeConnectorConnectionState>,
) {
	const session = state.workerSessions[sessionIndex]
	if (!session) {
		throw new Error(
			`Unknown worker session index ${sessionIndex}; ${state.workerSessions.length} session(s) configured.`,
		)
	}
	state.workerSessions[sessionIndex] = {
		...session,
		...input,
	}
	if (sessionIndex === 0) {
		updateConnectionState(state, input)
	}
	return state.workerSessions[sessionIndex]
}

export function setRokuDevices(
	state: HomeConnectorState,
	devices: Array<RokuDeviceRecord>,
) {
	state.devices = [...devices]
	return state.devices
}

export function setRokuDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: RokuDiscoveryDiagnostics | null,
) {
	state.rokuDiscoveryDiagnostics = diagnostics
	return state.rokuDiscoveryDiagnostics
}

export function setSamsungTvDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: SamsungTvDiscoveryDiagnostics | null,
) {
	state.samsungTvDiscoveryDiagnostics = diagnostics
	return state.samsungTvDiscoveryDiagnostics
}

export function setLutronDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: LutronDiscoveryDiagnostics | null,
) {
	state.lutronDiscoveryDiagnostics = diagnostics
	return state.lutronDiscoveryDiagnostics
}

export function setSonosDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: SonosDiscoveryDiagnostics | null,
) {
	state.sonosDiscoveryDiagnostics = diagnostics
	return state.sonosDiscoveryDiagnostics
}

export function setBondDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: BondDiscoveryDiagnostics | null,
) {
	state.bondDiscoveryDiagnostics = diagnostics
	return state.bondDiscoveryDiagnostics
}

export function setJellyfishDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: JellyfishDiscoveryDiagnostics | null,
) {
	state.jellyfishDiscoveryDiagnostics = diagnostics
	return state.jellyfishDiscoveryDiagnostics
}

export function setJellyfishDiscoveredControllers(
	state: HomeConnectorState,
	controllers: Array<JellyfishDiscoveredController>,
) {
	state.jellyfishDiscoveredControllers = [...controllers]
	return state.jellyfishDiscoveredControllers
}

export function setVenstarDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: VenstarDiscoveryDiagnostics | null,
) {
	state.venstarDiscoveryDiagnostics = diagnostics
	return state.venstarDiscoveryDiagnostics
}

export function setVenstarDiscoveredThermostats(
	state: HomeConnectorState,
	thermostats: Array<VenstarDiscoveredThermostat>,
) {
	state.venstarDiscoveredThermostats = [...thermostats]
	return state.venstarDiscoveredThermostats
}

export function setAccessNetworksUnleashedDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics | null,
) {
	state.accessNetworksUnleashedDiscoveryDiagnostics = diagnostics
	return state.accessNetworksUnleashedDiscoveryDiagnostics
}

export function setKasaDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: KasaDiscoveryDiagnostics | null,
) {
	state.kasaDiscoveryDiagnostics = diagnostics
	return state.kasaDiscoveryDiagnostics
}

export function getDiscoveredRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => !device.adopted)
}

export function getAdoptedRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => device.adopted)
}
