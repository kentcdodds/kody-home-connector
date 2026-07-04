import { beforeEach, expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createSonosAdapter } from './index.ts'
import { resetMockSonosState } from './mock-driver.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.SONOS_DISCOVERY_URL = 'http://sonos.mock.local/discovery'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

beforeEach(() => {
	resetMockSonosState()
})

test('sonos scan persists discovered players and diagnostics', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const status = sonos.getStatus()

		expect(players.length).toBeGreaterThan(0)
		expect(status.allPlayers.length).toBe(players.length)
		expect(status.diagnostics).not.toBeNull()
	} finally {
		storage.close()
	}
})

test('sonos favorite playback and queue operations work in mock mode', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const playerId = players[0]!.playerId
		sonos.adoptPlayer(playerId)

		const favorite = await sonos.playFavorite({
			playerId,
			title: 'Relaxing Piano Broadway Mix',
		})
		const queue = await sonos.listQueue(playerId)
		const statusAfterPlay = await sonos.getPlayerStatus(playerId)
		await sonos.removeQueueTrack({
			playerId,
			position: 1,
		})
		const queueAfterRemove = await sonos.listQueue(playerId)

		expect(favorite.title).toBe('Relaxing Piano Broadway Mix')
		expect(queue.length).toBeGreaterThan(0)
		expect(statusAfterPlay.transportState).toBe('PLAYING')
		expect(queueAfterRemove.length).toBe(queue.length - 1)
	} finally {
		storage.close()
	}
})

test('sonos enqueue uri supports bare Spotify playlist containers in mock mode', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const playerId = players[0]!.playerId
		sonos.adoptPlayer(playerId)

		await sonos.playFavorite({
			playerId,
			title: 'Relaxing Piano Broadway Mix',
		})
		await sonos.nextTrack(playerId)
		const result = await sonos.enqueueUri({
			playerId,
			uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
			clearQueue: true,
			enqueueAsNext: true,
			playNow: true,
		})
		const queue = await sonos.listQueue(playerId)
		const statusAfterPlay = await sonos.getPlayerStatus(playerId)

		expect(result).toMatchObject({
			firstTrackNumberEnqueued: 1,
			numTracksAdded: 2,
			newQueueLength: 2,
		})
		expect(queue[0]?.uri).toContain(
			'x-rincon-cpcontainer:1006286cspotify%3Aplaylist%3A37i9dQZF1DXcBWIGoYBM5M',
		)
		expect(statusAfterPlay.transportState).toBe('PLAYING')
		expect(statusAfterPlay.trackTitle).toBe(
			'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M Track 1',
		)
	} finally {
		storage.close()
	}
})

test('sonos create and delete favorite update mock favorites', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const playerId = players[0]!.playerId
		sonos.adoptPlayer(playerId)

		const favorite = await sonos.createFavorite({
			playerId,
			title: 'July Fourth Playlist',
			uri: 'x-rincon-cpcontainer:1006286cspotify%3Aplaylist%3Ajulyfourth?sid=12&flags=10348&sn=6',
			metadata:
				'<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="1006286cspotify%3Aplaylist%3Ajulyfourth" parentID="1006286cspotify%3Aplaylist%3Ajulyfourth" restricted="true"><dc:title>July Fourth Playlist</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON3079_X_#Svc3079-mock</desc></item></DIDL-Lite>',
			description: 'Spotify',
		})
		const favorites = await sonos.listFavorites(playerId)
		const originalSecondFavoriteId = favorites.find(
			(entry) => entry.title === 'Upbeat Dance Mix',
		)?.favoriteId
		await sonos.playFavorite({
			playerId,
			favoriteId: favorite.favoriteId,
		})
		const statusAfterPlay = await sonos.getPlayerStatus(playerId)
		await sonos.deleteFavorite({
			playerId,
			favoriteId: favorite.favoriteId,
		})
		const favoritesAfterDelete = await sonos.listFavorites(playerId)
		const secondFavoriteIdAfterDelete = favoritesAfterDelete.find(
			(entry) => entry.title === 'Upbeat Dance Mix',
		)?.favoriteId

		expect(favorite).toMatchObject({
			favoriteId: expect.stringMatching(/^FV:2\//),
			title: 'July Fourth Playlist',
		})
		expect(
			favorites.some((entry) => entry.favoriteId === favorite.favoriteId),
		).toBe(true)
		expect(statusAfterPlay.transportState).toBe('PLAYING')
		expect(
			favoritesAfterDelete.some(
				(entry) => entry.favoriteId === favorite.favoriteId,
			),
		).toBe(false)
		expect(secondFavoriteIdAfterDelete).toBe(originalSecondFavoriteId)
	} finally {
		storage.close()
	}
})

test('sonos grouping and audio input commands work in mock mode', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const sourcePlayerId = players[0]!.playerId
		const secondPlayerId = players[1]!.playerId
		sonos.adoptPlayer(sourcePlayerId)
		sonos.adoptPlayer(secondPlayerId)

		await sonos.groupPlayers({
			playerId: secondPlayerId,
			coordinatorPlayerId: sourcePlayerId,
		})
		const groupsAfterGroup = await sonos.listGroups(sourcePlayerId)
		await sonos.selectAudioInput(sourcePlayerId)
		const audioInput = await sonos.getAudioInput(sourcePlayerId)
		await sonos.setLineInLevel(sourcePlayerId, 8, 8)
		await sonos.startLineInToGroup({
			sourcePlayerId,
			coordinatorPlayerId: sourcePlayerId,
		})
		await sonos.ungroupPlayer(secondPlayerId)
		const groupsAfterUngroup = await sonos.listGroups(sourcePlayerId)

		expect(groupsAfterGroup.some((group) => group.members.length === 2)).toBe(
			true,
		)
		expect(audioInput.supported).toBe(true)
		expect(audioInput.lineInUri).toContain('x-rincon-stream:')
		expect(
			groupsAfterUngroup.every((group) => group.members.length === 1),
		).toBe(true)
	} finally {
		storage.close()
	}
})
