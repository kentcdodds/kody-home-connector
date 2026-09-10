import { type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { jellyfishControllers } from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import {
	type JellyfishDiscoveredController,
	type JellyfishPersistedController,
} from './types.ts'

function mapJellyfishControllerRow(
	row: TableRow<typeof jellyfishControllers>,
): JellyfishPersistedController {
	return {
		controllerId: row.controller_id,
		name: row.name,
		hostname: row.hostname,
		host: row.host,
		port: row.port,
		firmwareVersion: row.firmware_version,
		lastSeenAt: row.last_seen_at,
		lastConnectedAt: row.last_connected_at,
		lastError: row.last_error,
	}
}

export async function listJellyfishControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(jellyfishControllers, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort(
			(a, b) =>
				compareNoCase(a.name, b.name) ||
				compareText(a.controller_id, b.controller_id),
		)
		.map(mapJellyfishControllerRow)
}

export async function getJellyfishController(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllerId: string,
) {
	const row = await storage.db.find(jellyfishControllers, {
		connector_id: connectorId,
		controller_id: controllerId,
	})
	return row ? mapJellyfishControllerRow(row) : null
}

export async function upsertDiscoveredJellyfishControllers(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllers: Array<JellyfishDiscoveredController>
}) {
	for (const controller of input.controllers) {
		const values = {
			name: controller.name,
			hostname: controller.hostname,
			host: controller.host,
			port: controller.port,
			firmware_version: controller.firmwareVersion,
			last_seen_at: controller.lastSeenAt,
		}
		await input.storage.db.query(jellyfishControllers).upsert(
			{
				connector_id: input.connectorId,
				controller_id: controller.controllerId,
				last_connected_at: null,
				last_error: null,
				...values,
			},
			{ update: values },
		)
	}
	return listJellyfishControllers(input.storage, input.connectorId)
}

export async function updateJellyfishControllerConnection(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
	host: string
	port: number
	lastConnectedAt: string | null
	lastError: string | null
}) {
	await input.storage.db.updateMany(
		jellyfishControllers,
		{
			host: input.host,
			port: input.port,
			last_connected_at: input.lastConnectedAt,
			last_error: input.lastError,
		},
		{
			where: {
				connector_id: input.connectorId,
				controller_id: input.controllerId,
			},
		},
	)
	return getJellyfishController(
		input.storage,
		input.connectorId,
		input.controllerId,
	)
}
