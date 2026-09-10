import { and, notInList, type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { sonosPlayers } from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import { type SonosPersistedPlayer, type SonosPlayerRecord } from './types.ts'

function mapSonosPlayerRow(
	row: TableRow<typeof sonosPlayers>,
): SonosPersistedPlayer {
	return {
		playerId: row.player_id,
		udn: row.udn,
		roomName: row.room_name,
		displayName: row.display_name,
		friendlyName: row.friendly_name,
		modelName: row.model_name,
		modelNumber: row.model_number,
		serialNum: row.serial_num,
		householdId: row.household_id,
		host: row.host,
		descriptionUrl: row.description_url,
		audioInputSupported: Boolean(row.audio_input_supported),
		adopted: Boolean(row.adopted),
		lastSeenAt: row.last_seen_at,
		rawDescriptionXml: row.raw_description_xml,
	}
}

export async function listSonosPlayers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(sonosPlayers, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort(
			(a, b) =>
				compareNoCase(a.room_name, b.room_name) ||
				compareText(a.player_id, b.player_id),
		)
		.map(mapSonosPlayerRow)
}

export async function getSonosPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	const row = await storage.db.find(sonosPlayers, {
		connector_id: connectorId,
		player_id: playerId,
	})
	return row ? mapSonosPlayerRow(row) : null
}

export async function requireSonosPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	const player = await getSonosPlayer(storage, connectorId, playerId)
	if (!player) {
		const error = new Error(
			`Sonos player "${playerId}" was not found.`,
		) as Error & {
			homeConnectorCaptureContext: {
				shouldCapture: false
				tags: {
					connector_vendor: 'sonos'
					sonos_caller_error: 'player_not_found'
				}
			}
		}
		error.name = 'SonosCallerError'
		error.homeConnectorCaptureContext = {
			shouldCapture: false,
			tags: {
				connector_vendor: 'sonos',
				sonos_caller_error: 'player_not_found',
			},
		}
		throw error
	}
	return player
}

export async function upsertDiscoveredSonosPlayers(
	storage: HomeConnectorStorage,
	connectorId: string,
	players: Array<SonosPlayerRecord>,
) {
	const existing = new Map(
		(await listSonosPlayers(storage, connectorId)).map((player) => [
			player.playerId,
			player,
		]),
	)
	for (const player of players) {
		const current = existing.get(player.playerId)
		const values = {
			udn: player.udn,
			room_name: player.roomName,
			display_name: player.displayName,
			friendly_name: player.friendlyName,
			model_name: player.modelName,
			model_number: player.modelNumber,
			serial_num: player.serialNum,
			household_id: player.householdId,
			host: player.host,
			description_url: player.descriptionUrl,
			audio_input_supported: player.audioInputSupported ? 1 : 0,
			last_seen_at: player.lastSeenAt,
			raw_description_xml: player.rawDescriptionXml,
		}
		await storage.db.query(sonosPlayers).upsert(
			{
				connector_id: connectorId,
				player_id: player.playerId,
				adopted: current?.adopted ? 1 : player.adopted ? 1 : 0,
				...values,
			},
			{ update: values },
		)
	}
	await storage.db.deleteMany(sonosPlayers, {
		where: and(
			{ connector_id: connectorId, adopted: 0 },
			notInList(
				'player_id',
				players.map((player) => player.playerId),
			),
		),
	})
	return listSonosPlayers(storage, connectorId)
}

export async function adoptSonosPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	await storage.db.updateMany(
		sonosPlayers,
		{ adopted: 1 },
		{ where: { connector_id: connectorId, player_id: playerId } },
	)
	return getSonosPlayer(storage, connectorId, playerId)
}
