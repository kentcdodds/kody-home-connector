import { and, notInList, type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { kasaCredentials, kasaPlugs } from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import {
	type KasaCredentials,
	type KasaDiscoveredPlug,
	type KasaPersistedPlug,
	type KasaPublicPlug,
	type KasaRelayState,
	type KasaSysInfo,
} from './types.ts'

function encryptPassword(password: string, sharedSecret: string | null) {
	return encryptSecret({
		value: password,
		sharedSecret,
		missingSecretMessage:
			'Cannot store Kasa credentials without HOME_CONNECTOR_SHARED_SECRET.',
	})
}

function encryptUsername(username: string, sharedSecret: string | null) {
	return encryptSecret({
		value: username,
		sharedSecret,
		missingSecretMessage:
			'Cannot store Kasa credentials without HOME_CONNECTOR_SHARED_SECRET.',
	})
}

function decryptPassword(password: string | null, sharedSecret: string | null) {
	return decryptSecret(password, sharedSecret)
}

function decryptUsername(username: string | null, sharedSecret: string | null) {
	return decryptSecret(username, sharedSecret)
}

function safeParseJson(value: string | null) {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

function normalizeRelayState(value: string | null): KasaRelayState {
	return value === 'on' || value === 'off' ? value : 'unknown'
}

function mapPlugRow(row: TableRow<typeof kasaPlugs>): KasaPersistedPlug {
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

export async function listKasaPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(kasaPlugs, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort(
			(a, b) =>
				compareNoCase(a.alias, b.alias) || compareText(a.plug_id, b.plug_id),
		)
		.map(mapPlugRow)
}

export async function listKasaPublicPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const credentials = await getKasaCredentials(storage, connectorId)
	return (await listKasaPlugs(storage, connectorId)).map((plug) =>
		toPublicPlug(plug, credentials),
	)
}

export function toKasaPublicPlug(
	plug: KasaPersistedPlug,
	credentials: KasaCredentials | null,
) {
	return toPublicPlug(plug, credentials)
}

export async function getKasaPlug(
	storage: HomeConnectorStorage,
	connectorId: string,
	plugId: string,
) {
	const row = await storage.db.find(kasaPlugs, {
		connector_id: connectorId,
		plug_id: plugId,
	})
	return row ? mapPlugRow(row) : null
}

function isHostFallbackPlugId(plugId: string) {
	return plugId.startsWith('host:')
}

export async function upsertDiscoveredKasaPlugs(
	storage: HomeConnectorStorage,
	connectorId: string,
	plugs: Array<KasaDiscoveredPlug>,
) {
	const existing = new Map(
		(await listKasaPlugs(storage, connectorId)).map((plug) => [
			plug.plugId,
			plug,
		]),
	)
	for (const plug of plugs) {
		const hostFallback = [...existing.values()].find(
			(current) =>
				current.host === plug.host &&
				current.port === plug.port &&
				isHostFallbackPlugId(current.plugId) &&
				!isHostFallbackPlugId(plug.plugId),
		)
		const adopted = existing.get(plug.plugId)?.adopted || hostFallback?.adopted
		await storage.db.query(kasaPlugs).upsert({
			connector_id: connectorId,
			plug_id: plug.plugId,
			alias: plug.alias,
			host: plug.host,
			port: plug.port,
			model: plug.model,
			mac: plug.mac,
			device_id: plug.deviceId,
			relay_state: plug.relayState,
			adopted: adopted ? 1 : 0,
			raw_sysinfo_json: plug.rawSysinfo
				? JSON.stringify(plug.rawSysinfo)
				: null,
			raw_discovery_json: plug.rawDiscovery
				? JSON.stringify(plug.rawDiscovery)
				: null,
			last_seen_at: plug.lastSeenAt,
		})
		if (hostFallback) {
			await storage.db.deleteMany(kasaPlugs, {
				where: {
					connector_id: connectorId,
					host: hostFallback.host,
					port: hostFallback.port,
					plug_id: hostFallback.plugId,
				},
			})
		}
	}
	if (plugs.length > 0) {
		await storage.db.deleteMany(kasaPlugs, {
			where: and(
				{ connector_id: connectorId, adopted: 0 },
				notInList(
					'plug_id',
					plugs.map((plug) => plug.plugId),
				),
			),
		})
	}
	return listKasaPlugs(storage, connectorId)
}

export async function adoptKasaPlug(
	storage: HomeConnectorStorage,
	connectorId: string,
	plugId: string,
) {
	await storage.db.updateMany(
		kasaPlugs,
		{ adopted: 1 },
		{ where: { connector_id: connectorId, plug_id: plugId } },
	)
	return getKasaPlug(storage, connectorId, plugId)
}

export async function removeKasaPlug(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
}) {
	await input.storage.db.deleteMany(kasaPlugs, {
		where: { connector_id: input.connectorId, plug_id: input.plugId },
	})
}

export async function updateKasaPlugSysinfo(input: {
	storage: HomeConnectorStorage
	connectorId: string
	plugId: string
	relayState: KasaRelayState
	rawSysinfo: KasaSysInfo | null
	lastSeenAt: string
}) {
	await input.storage.db.updateMany(
		kasaPlugs,
		{
			relay_state: input.relayState,
			raw_sysinfo_json: input.rawSysinfo
				? JSON.stringify(input.rawSysinfo)
				: null,
			last_seen_at: input.lastSeenAt,
		},
		{ where: { connector_id: input.connectorId, plug_id: input.plugId } },
	)
	return getKasaPlug(input.storage, input.connectorId, input.plugId)
}

export async function saveKasaCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	username: string
	password: string
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}) {
	await input.storage.db.query(kasaCredentials).upsert({
		connector_id: input.connectorId,
		username: encryptUsername(input.username, input.storage.sharedSecret),
		password: encryptPassword(input.password, input.storage.sharedSecret),
		last_authenticated_at: input.lastAuthenticatedAt ?? null,
		last_auth_error: input.lastAuthError ?? null,
	})
	return getKasaCredentials(input.storage, input.connectorId)
}

export async function getKasaCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
): Promise<KasaCredentials | null> {
	const row = await storage.db.find(kasaCredentials, {
		connector_id: connectorId,
	})
	if (!row) return null
	const username = decryptUsername(row.username, storage.sharedSecret)
	const password = decryptPassword(row.password, storage.sharedSecret)
	if (!username || !password) return null
	return {
		username,
		password,
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
		source: 'stored',
	}
}

export async function updateKasaAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	await input.storage.db.updateMany(
		kasaCredentials,
		{
			last_authenticated_at: input.lastAuthenticatedAt,
			last_auth_error: input.lastAuthError,
		},
		{ where: { connector_id: input.connectorId } },
	)
}
