import { type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { venstarThermostats } from '../../storage/schema.ts'
import { compareNoCase } from '../../storage/sort.ts'

export type VenstarPersistedThermostat = {
	name: string
	ip: string
	lastSeenAt: string | null
}

function mapVenstarThermostatRow(
	row: TableRow<typeof venstarThermostats>,
): VenstarPersistedThermostat {
	return {
		name: row.name,
		ip: row.ip,
		lastSeenAt: row.last_seen_at,
	}
}

export async function listVenstarThermostats(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(venstarThermostats, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort((a, b) => compareNoCase(a.name, b.name) || compareNoCase(a.ip, b.ip))
		.map(mapVenstarThermostatRow)
}

export async function getVenstarThermostat(
	storage: HomeConnectorStorage,
	connectorId: string,
	ip: string,
) {
	const row = await storage.db.find(venstarThermostats, {
		connector_id: connectorId,
		ip,
	})
	return row ? mapVenstarThermostatRow(row) : null
}

export async function upsertVenstarThermostat(input: {
	storage: HomeConnectorStorage
	connectorId: string
	name: string
	ip: string
	lastSeenAt?: string | null
}) {
	await input.storage.db.query(venstarThermostats).upsert({
		connector_id: input.connectorId,
		ip: input.ip,
		name: input.name,
		last_seen_at: input.lastSeenAt ?? null,
	})
	return getVenstarThermostat(input.storage, input.connectorId, input.ip)
}

export async function removeVenstarThermostat(input: {
	storage: HomeConnectorStorage
	connectorId: string
	ip: string
}) {
	await input.storage.db.deleteMany(venstarThermostats, {
		where: { connector_id: input.connectorId, ip: input.ip },
	})
}

export async function updateVenstarLastSeen(input: {
	storage: HomeConnectorStorage
	connectorId: string
	ip: string
	lastSeenAt: string | null
}) {
	await input.storage.db.updateMany(
		venstarThermostats,
		{ last_seen_at: input.lastSeenAt },
		{ where: { connector_id: input.connectorId, ip: input.ip } },
	)
}
