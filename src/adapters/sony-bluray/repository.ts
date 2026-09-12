import { type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { sonyIrccPlayers } from '../../storage/schema.ts'
import { compareNoCase } from '../../storage/sort.ts'
import { courtBlurayPlayerId, type SonyIrccPersistedPlayer } from './types.ts'

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

function mapPlayerRow(
	row: TableRow<typeof sonyIrccPlayers>,
): SonyIrccPersistedPlayer {
	return {
		playerId: row.player_id,
		name: row.name,
		host: row.host,
		macAddress: row.mac_address,
		model: row.model,
		manufacturer: row.manufacturer,
		irccControlUrl: row.ircc_control_url,
		hasAuthCookie: Boolean(row.auth_cookie),
		hasPsk: Boolean(row.auth_psk),
		adopted: Boolean(row.adopted),
		lastSeenAt: row.last_seen_at,
		rawProbe: safeParseJson(row.raw_probe_json),
	}
}

function encryptOptionalSecret(input: {
	value: string
	sharedSecret: string | null
	label: string
}) {
	return encryptSecret({
		value: input.value,
		sharedSecret: input.sharedSecret,
		missingSecretMessage: `Cannot store a Sony IRCC ${input.label} without HOME_CONNECTOR_SHARED_SECRET.`,
	})
}

export async function listSonyIrccPlayers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(sonyIrccPlayers, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort(
			(a, b) => compareNoCase(a.name, b.name) || compareNoCase(a.host, b.host),
		)
		.map(mapPlayerRow)
}

export async function getSonyIrccPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	const row = await storage.db.find(sonyIrccPlayers, {
		connector_id: connectorId,
		player_id: playerId,
	})
	return row ? mapPlayerRow(row) : null
}

export async function getCourtSonyIrccPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const court = await getSonyIrccPlayer(
		storage,
		connectorId,
		courtBlurayPlayerId,
	)
	if (court) return court
	const players = await listSonyIrccPlayers(storage, connectorId)
	return players.find((player) => player.adopted) ?? null
}

export async function getSonyIrccAuth(input: {
	storage: HomeConnectorStorage
	connectorId: string
	playerId: string
}) {
	const row = await input.storage.db.find(sonyIrccPlayers, {
		connector_id: input.connectorId,
		player_id: input.playerId,
	})
	if (!row) {
		return { authCookie: null, psk: null }
	}
	return {
		authCookie: decryptSecret(row.auth_cookie, input.storage.sharedSecret),
		psk: decryptSecret(row.auth_psk, input.storage.sharedSecret),
	}
}

export async function upsertSonyIrccPlayer(input: {
	storage: HomeConnectorStorage
	connectorId: string
	player: {
		playerId: string
		name: string
		host: string
		macAddress?: string | null
		model?: string | null
		manufacturer?: string | null
		irccControlUrl?: string | null
		lastSeenAt?: string | null
		rawProbe?: Record<string, unknown> | null
	}
	adopted?: boolean
	authCookie?: string | null
	psk?: string | null
}) {
	const existing = await input.storage.db.find(sonyIrccPlayers, {
		connector_id: input.connectorId,
		player_id: input.player.playerId,
	})
	const nextCookie =
		input.authCookie === undefined
			? (existing?.auth_cookie ?? null)
			: input.authCookie
				? encryptOptionalSecret({
						value: input.authCookie,
						sharedSecret: input.storage.sharedSecret,
						label: 'auth cookie',
					})
				: null
	const nextPsk =
		input.psk === undefined
			? (existing?.auth_psk ?? null)
			: input.psk
				? encryptOptionalSecret({
						value: input.psk,
						sharedSecret: input.storage.sharedSecret,
						label: 'PSK',
					})
				: null
	await input.storage.db.query(sonyIrccPlayers).upsert({
		connector_id: input.connectorId,
		player_id: input.player.playerId,
		name: input.player.name,
		host: input.player.host,
		mac_address: input.player.macAddress ?? existing?.mac_address ?? null,
		model: input.player.model ?? existing?.model ?? null,
		manufacturer: input.player.manufacturer ?? existing?.manufacturer ?? null,
		ircc_control_url:
			input.player.irccControlUrl ?? existing?.ircc_control_url ?? null,
		auth_cookie: nextCookie,
		auth_psk: nextPsk,
		adopted:
			input.adopted === undefined
				? existing?.adopted
					? 1
					: 0
				: input.adopted
					? 1
					: 0,
		raw_probe_json: input.player.rawProbe
			? JSON.stringify(input.player.rawProbe)
			: (existing?.raw_probe_json ?? null),
		last_seen_at: input.player.lastSeenAt ?? existing?.last_seen_at ?? null,
	})
	return getSonyIrccPlayer(
		input.storage,
		input.connectorId,
		input.player.playerId,
	)
}

export async function removeSonyIrccPlayer(input: {
	storage: HomeConnectorStorage
	connectorId: string
	playerId: string
}) {
	await input.storage.db.deleteMany(sonyIrccPlayers, {
		where: {
			connector_id: input.connectorId,
			player_id: input.playerId,
		},
	})
}
