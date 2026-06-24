import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type KasaDiscoveredPlug,
	type KasaPersistedPlug,
	type KasaPublicPlug,
	type KasaRelayState,
	type KasaSysInfo,
} from './types.ts'

type KasaPlugRow = {
	connector_id: string
	plug_id: string
	alias: string
	host: string
	port: number
	model: string | null
	mac_address: string | null
	device_id: string | null
	hw_id: string | null
	sw_ver: string | null
	relay_state: number | null
	led_off: number | null
	on_time: number | null
	raw_sysinfo_json: string
	adopted: number
	last_seen_at: string
	last_connected_at: string | null
	last_error: string | null
}

function parseJson(value: string): KasaSysInfo {
	return JSON.parse(value) as KasaSysInfo
}

function mapKasaPlugRow(row: KasaPlugRow): KasaPersistedPlug {
	return {
		plugId: row.plug_id,
		alias: row.alias,
		host: row.host,
		port: row.port,
		model: row.model,
		macAddress: row.mac_address,
		deviceId: row.device_id,
		hwId: row.hw_id,
		swVer: row.sw_ver,
		relayState:
			row.relay_state === 0 || row.relay_state === 1 ? row.relay_state : null,
		ledOff: row.led_off,
		onTime: row.on_time,
		lastSeenAt: row.last_seen_at,
		rawSysInfo: parseJson(row.raw_sysinfo_json),
		adopted: Boolean(row.adopted),
		lastConnectedAt: row.last_connected_at,
		lastError: row.last_error,
	}
}

export function toKasaPublicPlug(plug: KasaPersistedPlug): KasaPublicPlug {
	return plug
}

function selectKasaPlugRows(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const statement = storage.db.query(`
		SELECT
			connector_id,
			plug_id,
			alias,
			host,
			port,
			model,
			mac_address,
			device_id,
			hw_id,
			sw_ver,
			relay_state,
			led_off,
			on_time,
			raw_sysinfo_json,
			adopted,
			last_seen_at,
			last_connected_at,
			last_error
		FROM kasa_plugs
		WHERE connector_id = ?
		ORDER BY alias COLLATE NOCASE, plug_id
	`)
	return statement.all(connectorId) as Array<KasaPlugRow>
}

function getUpsertKasaPlugStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO kasa_plugs (
			connector_id,
			plug_id,
			alias,
			host,
			port,
			model,
			mac_address,
			device_id,
			hw_id,
			sw_ver,
			relay_state,
			led_off,
			on_time,
			raw_sysinfo_json,
			adopted,
			last_seen_at,
			last_connected_at,
			last_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, plug_id) DO UPDATE SET
			alias = excluded.alias,
			host = excluded.host,
			port = excluded.port,
			model = excluded.model,
			mac_address = excluded.mac_address,
			device_id = excluded.device_id,
			hw_id = excluded.hw_id,
			sw_ver = excluded.sw_ver,
			relay_state = excluded.relay_state,
			led_off = excluded.led_off,
			on_time = excluded.on_time,
			raw_sysinfo_json = excluded.raw_sysinfo_json,
			last_seen_at = excluded.last_seen_at,
			last_connected_at = excluded.last_connected_at,
			last_error = excluded.last_error,
			updated_at = excluded.updated_at
	`)
}

function getMarkKasaPlugAdoptedStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE kasa_plugs
		SET adopted = 1,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND plug_id = ?
	`)
}

function getDeleteKasaPlugStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM kasa_plugs
		WHERE connector_id = ? AND plug_id = ?
	`)
}

function getUpdateKasaPlugConnectionStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE kasa_plugs
		SET
			host = ?,
			port = ?,
			relay_state = ?,
			led_off = ?,
			on_time = ?,
			raw_sysinfo_json = ?,
			last_seen_at = ?,
			last_connected_at = ?,
			last_error = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND plug_id = ?
	`)
}

export function listKasaPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectKasaPlugRows(storage, connectorId).map(mapKasaPlugRow)
}

export function getKasaPlug(
	storage: HomeConnectorStorage,
	connectorId: string,
	plugId: string,
) {
	return (
		listKasaPlugs(storage, connectorId).find(
			(plug) => plug.plugId === plugId,
		) ?? null
	)
}

export function upsertDiscoveredKasaPlugs(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugs: Array<KasaDiscoveredPlug>
}) {
	const now = new Date().toISOString()
	const statement = getUpsertKasaPlugStatement(input.storage)
	for (const plug of input.plugs) {
		statement.run(
			input.connectorId,
			plug.plugId,
			plug.alias,
			plug.host,
			plug.port,
			plug.model,
			plug.macAddress,
			plug.deviceId,
			plug.hwId,
			plug.swVer,
			plug.relayState,
			plug.ledOff,
			plug.onTime,
			JSON.stringify(plug.rawSysInfo),
			0,
			plug.lastSeenAt,
			plug.lastSeenAt,
			null,
			now,
		)
	}
	return listKasaPlugs(input.storage, input.connectorId)
}

export function adoptKasaPlug(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
}) {
	getMarkKasaPlugAdoptedStatement(input.storage).run(
		input.connectorId,
		input.plugId,
	)
	return getKasaPlug(input.storage, input.connectorId, input.plugId)
}

export function removeKasaPlug(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
}) {
	getDeleteKasaPlugStatement(input.storage).run(input.connectorId, input.plugId)
}

export function updateKasaPlugConnection(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
	host: string
	port: number
	relayState: KasaRelayState | null
	ledOff: number | null
	onTime: number | null
	rawSysInfo: KasaSysInfo
	lastSeenAt: string
	lastConnectedAt: string | null
	lastError: string | null
}) {
	getUpdateKasaPlugConnectionStatement(input.storage).run(
		input.host,
		input.port,
		input.relayState,
		input.ledOff,
		input.onTime,
		JSON.stringify(input.rawSysInfo),
		input.lastSeenAt,
		input.lastConnectedAt,
		input.lastError,
		input.connectorId,
		input.plugId,
	)
	return getKasaPlug(input.storage, input.connectorId, input.plugId)
}
