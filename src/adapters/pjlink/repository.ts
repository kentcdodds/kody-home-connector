import { type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { pjlinkProjectors } from '../../storage/schema.ts'
import { compareNoCase } from '../../storage/sort.ts'
import {
	type PjlinkDiscoveredProjector,
	type PjlinkPersistedProjector,
} from './types.ts'

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

function mapProjectorRow(
	row: TableRow<typeof pjlinkProjectors>,
): PjlinkPersistedProjector {
	return {
		projectorId: row.projector_id,
		name: row.name,
		host: row.host,
		port: row.port,
		macAddress: row.mac_address,
		manufacturer: row.manufacturer,
		model: row.model,
		authRequired: Boolean(row.auth_required),
		lastSeenAt: row.last_seen_at,
		rawDiscovery: safeParseJson(row.raw_discovery_json),
		adopted: Boolean(row.adopted),
		hasPassword: Boolean(row.password),
	}
}

export function encryptPjlinkPassword(input: {
	password: string
	sharedSecret: string | null
}) {
	return encryptSecret({
		value: input.password,
		sharedSecret: input.sharedSecret,
		missingSecretMessage:
			'Cannot store a PJLink password without HOME_CONNECTOR_SHARED_SECRET.',
	})
}

export function decryptPjlinkPassword(input: {
	password: string | null
	sharedSecret: string | null
}) {
	return decryptSecret(input.password, input.sharedSecret)
}

export async function listPjlinkProjectors(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(pjlinkProjectors, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort(
			(a, b) => compareNoCase(a.name, b.name) || compareNoCase(a.host, b.host),
		)
		.map(mapProjectorRow)
}

export async function getPjlinkProjector(
	storage: HomeConnectorStorage,
	connectorId: string,
	projectorId: string,
) {
	const row = await storage.db.find(pjlinkProjectors, {
		connector_id: connectorId,
		projector_id: projectorId,
	})
	return row ? mapProjectorRow(row) : null
}

export async function getPjlinkProjectorPassword(input: {
	storage: HomeConnectorStorage
	connectorId: string
	projectorId: string
}) {
	const row = await input.storage.db.find(pjlinkProjectors, {
		connector_id: input.connectorId,
		projector_id: input.projectorId,
	})
	if (!row) return null
	return decryptPjlinkPassword({
		password: row.password,
		sharedSecret: input.storage.sharedSecret,
	})
}

export async function upsertDiscoveredPjlinkProjectors(input: {
	storage: HomeConnectorStorage
	connectorId: string
	projectors: Array<PjlinkDiscoveredProjector>
}) {
	for (const projector of input.projectors) {
		const existingRow = await input.storage.db.find(pjlinkProjectors, {
			connector_id: input.connectorId,
			projector_id: projector.projectorId,
		})
		await input.storage.db.query(pjlinkProjectors).upsert({
			connector_id: input.connectorId,
			projector_id: projector.projectorId,
			name: projector.name,
			host: projector.host,
			port: projector.port,
			mac_address: projector.macAddress,
			manufacturer: projector.manufacturer,
			model: projector.model,
			auth_required: projector.authRequired ? 1 : 0,
			password: existingRow?.password ?? null,
			adopted: existingRow?.adopted ? 1 : 0,
			raw_discovery_json: projector.rawDiscovery
				? JSON.stringify(projector.rawDiscovery)
				: null,
			last_seen_at: projector.lastSeenAt,
		})
	}
}

export async function upsertPjlinkProjector(input: {
	storage: HomeConnectorStorage
	connectorId: string
	projector: PjlinkDiscoveredProjector
	adopted?: boolean
	password?: string | null
}) {
	const existingRow = await input.storage.db.find(pjlinkProjectors, {
		connector_id: input.connectorId,
		projector_id: input.projector.projectorId,
	})
	const nextPassword =
		input.password === undefined
			? (existingRow?.password ?? null)
			: input.password
				? encryptPjlinkPassword({
						password: input.password,
						sharedSecret: input.storage.sharedSecret,
					})
				: null
	await input.storage.db.query(pjlinkProjectors).upsert({
		connector_id: input.connectorId,
		projector_id: input.projector.projectorId,
		name: input.projector.name,
		host: input.projector.host,
		port: input.projector.port,
		mac_address: input.projector.macAddress,
		manufacturer: input.projector.manufacturer,
		model: input.projector.model,
		auth_required: input.projector.authRequired ? 1 : 0,
		password: nextPassword,
		adopted:
			input.adopted === undefined
				? existingRow?.adopted
					? 1
					: 0
				: input.adopted
					? 1
					: 0,
		raw_discovery_json: input.projector.rawDiscovery
			? JSON.stringify(input.projector.rawDiscovery)
			: (existingRow?.raw_discovery_json ?? null),
		last_seen_at:
			input.projector.lastSeenAt ?? existingRow?.last_seen_at ?? null,
	})
	return getPjlinkProjector(
		input.storage,
		input.connectorId,
		input.projector.projectorId,
	)
}

export async function adoptPjlinkProjector(input: {
	storage: HomeConnectorStorage
	connectorId: string
	projectorId: string
	password?: string | null
}) {
	const existing = await getPjlinkProjector(
		input.storage,
		input.connectorId,
		input.projectorId,
	)
	if (!existing) return null
	const nextPassword =
		input.password === undefined
			? undefined
			: input.password
				? encryptPjlinkPassword({
						password: input.password,
						sharedSecret: input.storage.sharedSecret,
					})
				: null
	await input.storage.db.updateMany(
		pjlinkProjectors,
		{
			adopted: 1,
			...(nextPassword !== undefined ? { password: nextPassword } : {}),
		},
		{
			where: {
				connector_id: input.connectorId,
				projector_id: input.projectorId,
			},
		},
	)
	return getPjlinkProjector(input.storage, input.connectorId, input.projectorId)
}

export async function removePjlinkProjector(input: {
	storage: HomeConnectorStorage
	connectorId: string
	projectorId: string
}) {
	await input.storage.db.deleteMany(pjlinkProjectors, {
		where: {
			connector_id: input.connectorId,
			projector_id: input.projectorId,
		},
	})
}

export async function updatePjlinkLastSeen(input: {
	storage: HomeConnectorStorage
	connectorId: string
	projectorId: string
	lastSeenAt: string
}) {
	await input.storage.db.updateMany(
		pjlinkProjectors,
		{ last_seen_at: input.lastSeenAt },
		{
			where: {
				connector_id: input.connectorId,
				projector_id: input.projectorId,
			},
		},
	)
}
