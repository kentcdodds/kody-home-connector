import { type HomeConnectorStorage } from '../../storage/index.ts'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import {
	type KasaCredentials,
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
	mac: string | null
	device_id: string | null
	relay_state: string | null
	adopted: number
	raw_sysinfo_json: string | null
	raw_discovery_json: string | null
	last_seen_at: string | null
}

type KasaCredentialsRow = {
	connector_id: string
	username: string
	password: string
	last_authenticated_at: string | null
	last_auth_error: string | null
}

function encryptPassword(password: string, sharedSecret: string | null) {
	return encryptSecret({
		value: password,
		sharedSecret,
		missingSecretMessage:
			'Cannot store Kasa credentials without HOME_CONNECTOR_SHARED_SECRET.',
	})
}

function decryptPassword(password: string | null, sharedSecret: string | null) {
	return decryptSecret(password, sharedSecret)
}

function safeParseJson(value: string | null) {
	if (!value) return null
	try {
		return JSON.parse(value) as Record<string, unknown>
	} catch {
		return null
	}
}

function normalizeRelayState(value: string | null): KasaRelayState {
	return value === 'on' || value === 'off' ? value : 'unknown'
}

function mapPlugRow(row: KasaPlugRow): KasaPersistedPlug {
	return {
		plugId: row.plug_id,
		alias: row.alias,
		host: row.host,
		port: row.port,
		model: row.model,
		mac: row.mac,
		deviceId: row.device_id,
		relayState: normalizeRelayState(row.relay_state),
		adopted: Boolean(row.adopted),
		rawSysinfo: safeParseJson(row.raw_sysinfo_json) as KasaSysInfo | null,
		rawDiscovery: safeParseJson(row.raw_discovery_json),
		lastSeenAt: row.last_seen_at,
	}
}

function toPublicPlug(
	plug: KasaPersistedPlug,
	credentials: KasaCredentials | null,
): KasaPublicPlug {
	return {
		...plug,
		hasCredentials: Boolean(credentials),
	}
}

function selectPlugRows(
	storage: HomeConnectorStorage,
	connectorId: string,
): Array<KasaPlugRow> {
	return storage.db
		.query(
			`
				SELECT
					connector_id,
					plug_id,
					alias,
					host,
					port,
					model,
					mac,
					device_id,
					relay_state,
					adopted,
					raw_sysinfo_json,
					raw_discovery_json,
					last_seen_at
				FROM kasa_plugs
				WHERE connector_id = ?
				ORDER BY alias COLLATE NOCASE, plug_id
			`,
		)
		.all(connectorId) as Array<KasaPlugRow>
}

function getUpsertPlugStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO kasa_plugs (
			connector_id,
			plug_id,
			alias,
			host,
			port,
			model,
			mac,
			device_id,
			relay_state,
			adopted,
			raw_sysinfo_json,
			raw_discovery_json,
			last_seen_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, plug_id) DO UPDATE SET
			alias = excluded.alias,
			host = excluded.host,
			port = excluded.port,
			model = excluded.model,
			mac = excluded.mac,
			device_id = excluded.device_id,
			relay_state = excluded.relay_state,
			raw_sysinfo_json = excluded.raw_sysinfo_json,
			raw_discovery_json = excluded.raw_discovery_json,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getDeleteMissingUnadoptedPlugsStatement(
	storage: HomeConnectorStorage,
) {
	return storage.db.query(`
		DELETE FROM kasa_plugs AS plug
		WHERE plug.connector_id = ?
			AND plug.plug_id NOT IN (
				SELECT value
				FROM json_each(?)
			)
			AND plug.adopted = 0
	`)
}

function getMarkPlugAdoptedStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE kasa_plugs
		SET adopted = 1,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND plug_id = ?
	`)
}

function getDeletePlugStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM kasa_plugs
		WHERE connector_id = ? AND plug_id = ?
	`)
}

function getUpdateRelayStateStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE kasa_plugs
		SET relay_state = ?,
			raw_sysinfo_json = ?,
			last_seen_at = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND plug_id = ?
	`)
}

function getUpsertCredentialsStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO kasa_credentials (
			connector_id,
			username,
			password,
			last_authenticated_at,
			last_auth_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id) DO UPDATE SET
			username = excluded.username,
			password = excluded.password,
			last_authenticated_at = excluded.last_authenticated_at,
			last_auth_error = excluded.last_auth_error,
			updated_at = excluded.updated_at
	`)
}

function getCredentialsRow(
	storage: HomeConnectorStorage,
	connectorId: string,
): KasaCredentialsRow | null {
	return (
		(storage.db
			.query(
				`
					SELECT
						connector_id,
						username,
						password,
						last_authenticated_at,
						last_auth_error
					FROM kasa_credentials
					WHERE connector_id = ?
				`,
			)
			.get(connectorId) as KasaCredentialsRow | undefined) ?? null
	)
}

function getUpdateAuthStatusStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE kasa_credentials
		SET last_authenticated_at = ?,
			last_auth_error = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ?
	`)
}

export function listKasaPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectPlugRows(storage, connectorId).map(mapPlugRow)
}

export function listKasaPublicPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const credentials = getKasaCredentials(storage, connectorId)
	return listKasaPlugs(storage, connectorId).map((plug) =>
		toPublicPlug(plug, credentials),
	)
}

export function toKasaPublicPlug(
	plug: KasaPersistedPlug,
	credentials: KasaCredentials | null,
) {
	return toPublicPlug(plug, credentials)
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

export function upsertDiscoveredKasaPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
	plugs: Array<KasaDiscoveredPlug>,
) {
	const existing = new Map(
		listKasaPlugs(storage, connectorId).map((plug) => [plug.plugId, plug]),
	)
	const now = new Date().toISOString()
	const upsertStatement = getUpsertPlugStatement(storage)
	for (const plug of plugs) {
		upsertStatement.run(
			connectorId,
			plug.plugId,
			plug.alias,
			plug.host,
			plug.port,
			plug.model,
			plug.mac,
			plug.deviceId,
			plug.relayState,
			existing.get(plug.plugId)?.adopted ? 1 : 0,
			plug.rawSysinfo ? JSON.stringify(plug.rawSysinfo) : null,
			plug.rawDiscovery ? JSON.stringify(plug.rawDiscovery) : null,
			plug.lastSeenAt,
			now,
		)
	}
	getDeleteMissingUnadoptedPlugsStatement(storage).run(
		connectorId,
		JSON.stringify(plugs.map((plug) => plug.plugId)),
	)
	return listKasaPlugs(storage, connectorId)
}

export function adoptKasaPlug(
	storage: HomeConnectorStorage,
	connectorId: string,
	plugId: string,
) {
	getMarkPlugAdoptedStatement(storage).run(connectorId, plugId)
	return getKasaPlug(storage, connectorId, plugId)
}

export function removeKasaPlug(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
}) {
	getDeletePlugStatement(input.storage).run(input.connectorId, input.plugId)
}

export function updateKasaPlugSysinfo(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
	relayState: KasaRelayState
	rawSysinfo: KasaSysInfo | null
	lastSeenAt: string
}) {
	getUpdateRelayStateStatement(input.storage).run(
		input.relayState,
		input.rawSysinfo ? JSON.stringify(input.rawSysinfo) : null,
		input.lastSeenAt,
		input.connectorId,
		input.plugId,
	)
	return getKasaPlug(input.storage, input.connectorId, input.plugId)
}

export function saveKasaCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	username: string
	password: string
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}) {
	const now = new Date().toISOString()
	getUpsertCredentialsStatement(input.storage).run(
		input.connectorId,
		input.username,
		encryptPassword(input.password, input.storage.sharedSecret),
		input.lastAuthenticatedAt ?? null,
		input.lastAuthError ?? null,
		now,
	)
	return getKasaCredentials(input.storage, input.connectorId)
}

export function getKasaCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
): KasaCredentials | null {
	const row = getCredentialsRow(storage, connectorId)
	if (!row) return null
	const password = decryptPassword(row.password, storage.sharedSecret)
	if (!password) return null
	return {
		username: row.username,
		password,
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
		source: 'stored',
	}
}

export function updateKasaAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	getUpdateAuthStatusStatement(input.storage).run(
		input.lastAuthenticatedAt,
		input.lastAuthError,
		input.connectorId,
	)
}
