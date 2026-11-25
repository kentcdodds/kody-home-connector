import { expect, test } from 'vitest'
import {
	buildGenericSpotifyDescToken,
	buildSonosSpotifyUri,
	createSpotifyServiceCandidateResolver,
	getSpotifyFallbackServiceInfos,
	getSpotifyServiceInfoFromAccounts,
	parseSpotifyUri,
	type SpotifyMetadataEntry,
	type SpotifyServiceCandidate,
	type SpotifyServiceInfo,
} from './spotify.ts'
import { type SonosFavorite } from './types.ts'

const mockDescToken = 'SA_RINCON3079_X_#Svc3079-mock'

function createFavorite(input: {
	uri: string
	className?: string
	descToken?: string | null
}): SonosFavorite {
	const desc =
		input.descToken === null
			? ''
			: `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${input.descToken ?? mockDescToken}</desc>`
	return {
		kind: 'item',
		id: 'FV:2/1',
		parentId: 'FV:2',
		favoriteId: 'FV:2/1',
		title: 'Favorite',
		className: 'object.itemobject.item.sonos-favorite',
		artist: null,
		album: null,
		uri: input.uri,
		metadata: `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="x" parentID="x" restricted="true"><dc:title>Favorite</dc:title><upnp:class>${input.className ?? 'object.container.playlistContainer'}</upnp:class>${desc}</item></DIDL-Lite>`,
		provider: 'Spotify',
		playbackType: null,
		isPlayable: true,
	}
}

const playlistFavorite = createFavorite({
	uri: 'x-rincon-cpcontainer:1006286cspotify%3Aplaylist%3Afav?sid=12&amp;flags=10348&amp;sn=6',
})

function extractClass(metadata: string) {
	return metadata.match(/<upnp:class>([^<]+)<\/upnp:class>/)?.[1]
}

function extractDesc(metadata: string) {
	return metadata.match(/<desc [^>]*>([^<]+)<\/desc>/)?.[1]
}

test('album, playlist, and track keep their existing Sonos encodings', () => {
	const favorites = [playlistFavorite]
	const playlist = buildSonosSpotifyUri({
		uri: 'spotify:playlist:abc123',
		favorites,
	})
	const album = buildSonosSpotifyUri({ uri: 'spotify:album:abc123', favorites })
	const track = buildSonosSpotifyUri({ uri: 'spotify:track:abc123', favorites })

	expect(playlist?.uri).toBe(
		'x-rincon-cpcontainer:1006286cspotify%3Aplaylist%3Aabc123?sid=12&flags=10348&sn=6',
	)
	expect(extractClass(playlist!.metadata)).toBe(
		'object.container.playlistContainer',
	)
	expect(extractDesc(playlist!.metadata)).toBe(mockDescToken)
	expect(album?.uri).toBe(
		'x-rincon-cpcontainer:1004006cspotify%3Aalbum%3Aabc123?sid=12&flags=108&sn=6',
	)
	expect(extractClass(album!.metadata)).toBe(
		'object.container.album.musicAlbum',
	)
	expect(track?.uri).toBe(
		'x-sonos-spotify:spotify%3Atrack%3Aabc123?sid=12&flags=8224&sn=6',
	)
	expect(extractClass(track!.metadata)).toBe('object.item.audioItem.musicTrack')
})

test('container prefixes and flags are learned from matching favorites', () => {
	const favorites = [
		playlistFavorite,
		createFavorite({
			uri: 'x-rincon-cpcontainer:1004206cspotify%3Aalbum%3Afav?sid=12&flags=8300&sn=6',
		}),
		createFavorite({
			uri: 'x-rincon-cpcontainer:100e2068spotify%3AartistTopTracks%3Afav?sid=12&flags=8232&sn=6',
		}),
		createFavorite({
			uri: 'x-rincon-cpcontainer:1006286cspotify%3Ashow%3Afav?sid=12&flags=10348&sn=6',
		}),
	]

	expect(
		buildSonosSpotifyUri({ uri: 'spotify:album:abc', favorites })?.uri,
	).toBe(
		'x-rincon-cpcontainer:1004206cspotify%3Aalbum%3Aabc?sid=12&flags=8300&sn=6',
	)
	expect(
		buildSonosSpotifyUri({ uri: 'spotify:artist:abc', favorites })?.uri,
	).toBe(
		'x-rincon-cpcontainer:100e2068spotify%3AartistTopTracks%3Aabc?sid=12&flags=8232&sn=6',
	)
	expect(
		buildSonosSpotifyUri({ uri: 'spotify:show:abc', favorites })?.uri,
	).toBe(
		'x-rincon-cpcontainer:1006286cspotify%3Ashow%3Aabc?sid=12&flags=10348&sn=6',
	)
})

test('artist maps to a Sonos artist top tracks container', () => {
	const artist = buildSonosSpotifyUri({
		uri: 'spotify:artist:0OdUWJ0sBjDrqHygGUXeCF',
		favorites: [playlistFavorite],
	})

	expect(artist?.uri).toBe(
		'x-rincon-cpcontainer:100e206cspotify%3AartistTopTracks%3A0OdUWJ0sBjDrqHygGUXeCF?sid=12&flags=8300&sn=6',
	)
	expect(artist?.metadata).toContain(
		'id="100e206cspotify%3AartistTopTracks%3A0OdUWJ0sBjDrqHygGUXeCF"',
	)
	expect(extractClass(artist!.metadata)).toBe(
		'object.container.playlistContainer',
	)
	expect(artist?.uri).not.toContain('artistRadio')
})

test('show maps to a queue-able container', () => {
	const show = buildSonosSpotifyUri({
		uri: 'spotify:show:5CfCWKI5pZ28U0uOzXkDHe',
		favorites: [playlistFavorite],
	})

	expect(show?.uri).toBe(
		'x-rincon-cpcontainer:1006206cspotify%3Ashow%3A5CfCWKI5pZ28U0uOzXkDHe?sid=12&flags=8300&sn=6',
	)
	expect(extractClass(show!.metadata)).toBe(
		'object.container.playlistContainer',
	)
	expect(extractDesc(show!.metadata)).toBe(mockDescToken)
})

test('episode maps to an x-sonos-spotify item', () => {
	const episode = buildSonosSpotifyUri({
		uri: 'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
		favorites: [playlistFavorite],
	})

	expect(episode?.uri).toBe(
		'x-sonos-spotify:spotify%3Aepisode%3A512ojhOuo1ktJprKbVcKyQ?sid=12&flags=8224&sn=6',
	)
	expect(extractClass(episode!.metadata)).toBe(
		'object.item.audioItem.musicTrack',
	)
})

test('concert links fail with a clear caller error', () => {
	expect(() =>
		buildSonosSpotifyUri({
			uri: 'spotify:concert:7DqnJZsD8sNZiF6JkWQHgO',
			favorites: [playlistFavorite],
		}),
	).toThrowError(
		expect.objectContaining({
			name: 'SonosCallerError',
			message: expect.stringContaining('not playable on Sonos'),
			homeConnectorCaptureContext: {
				shouldCapture: false,
				tags: {
					connector_vendor: 'sonos',
					sonos_caller_error: 'spotify_concert_unplayable',
				},
			},
		}),
	)
})

test('invalid Spotify URIs are rejected', () => {
	for (const uri of [
		'spotify:podcast:abc',
		'spotify:track:',
		'spotify:track:abc-def',
		'spotify:artistTopTracks:abc',
		'https://open.spotify.com/track/abc',
		'x-sonos-spotify:spotify%3Atrack%3Aabc',
	]) {
		expect(parseSpotifyUri(uri)).toBeNull()
		expect(
			buildSonosSpotifyUri({ uri, favorites: [playlistFavorite] }),
		).toBeNull()
	}
	expect(parseSpotifyUri(' spotify:artist:abc ')).toEqual({
		kind: 'artist',
		id: 'abc',
		spotifyUri: 'spotify:artist:abc',
	})
})

test('service metadata comes from a favorite when one exists', () => {
	const favorite = createFavorite({
		uri: 'x-sonos-spotify:spotify%3Atrack%3Afav?sid=9&amp;flags=8224&amp;sn=3',
		className: 'object.item.audioItem.musicTrack',
		descToken: 'SA_RINCON2311_X_#Svc2311-mock',
	})
	const track = buildSonosSpotifyUri({
		uri: 'spotify:track:abc',
		favorites: [favorite],
	})

	expect(track?.uri).toBe(
		'x-sonos-spotify:spotify%3Atrack%3Aabc?sid=9&flags=8224&sn=3',
	)
	expect(extractDesc(track!.metadata)).toBe('SA_RINCON2311_X_#Svc2311-mock')
})

test('without favorites or resolved service info, metadata is unavailable', () => {
	expect(() =>
		buildSonosSpotifyUri({ uri: 'spotify:artist:abc', favorites: [] }),
	).toThrowError(
		expect.objectContaining({
			name: 'SonosCallerError',
			homeConnectorCaptureContext: expect.objectContaining({
				shouldCapture: false,
				tags: expect.objectContaining({
					sonos_caller_error: 'spotify_metadata_unavailable',
				}),
			}),
		}),
	)
})

test('explicit service info builds URIs with no favorites', () => {
	const serviceInfo: SpotifyServiceInfo = {
		sid: '12',
		sn: '6',
		descToken: buildGenericSpotifyDescToken('12'),
	}
	const episode = buildSonosSpotifyUri({
		uri: 'spotify:episode:abc',
		favorites: [],
		serviceInfo,
	})

	expect(serviceInfo.descToken).toBe('SA_RINCON3079_X_#Svc3079-0-Token')
	expect(episode?.uri).toBe(
		'x-sonos-spotify:spotify%3Aepisode%3Aabc?sid=12&flags=8224&sn=6',
	)
	expect(extractDesc(episode!.metadata)).toBe(
		'SA_RINCON3079_X_#Svc3079-0-Token',
	)
})

async function collect(
	resolver: ReturnType<typeof createSpotifyServiceCandidateResolver>,
) {
	const candidates: Array<SpotifyServiceCandidate> = []
	for await (const candidate of resolver.candidates) candidates.push(candidate)
	return candidates
}

async function* entries(list: Array<SpotifyMetadataEntry>) {
	yield* list
}

test('candidate resolver prefers favorites, then players, accounts, cache, fallbacks', async () => {
	const resolver = createSpotifyServiceCandidateResolver({
		favorites: [playlistFavorite],
		listPlayerMetadataEntries: () =>
			entries([
				{ uri: 'x-rincon-queue:RINCON_1#0', metadata: null },
				{
					uri: 'x-sonos-spotify:spotify%3Atrack%3Aq?sid=12&flags=8224&sn=8',
					metadata: null,
				},
			]),
		listMusicServiceAccounts: async () => [{ type: '3079', serialNum: '9' }],
		readCachedServiceInfo: async () => ({
			sid: '12',
			sn: '4',
			descToken: 'SA_RINCON3079_X_#Svc3079-cached',
		}),
	})

	const candidates = await collect(resolver)

	expect(candidates.slice(0, 4)).toEqual([
		{ sid: '12', sn: '6', descToken: mockDescToken, source: 'favorite' },
		{
			sid: '12',
			sn: '8',
			descToken: 'SA_RINCON3079_X_#Svc3079-0-Token',
			source: 'player',
		},
		{
			sid: '12',
			sn: '9',
			descToken: 'SA_RINCON3079_X_#Svc3079-0-Token',
			source: 'account',
		},
		{
			sid: '12',
			sn: '4',
			descToken: 'SA_RINCON3079_X_#Svc3079-cached',
			source: 'cache',
		},
	])
	expect(candidates.slice(4).every((c) => c.source === 'fallback')).toBe(true)
	expect(resolver.tried.join(' ')).not.toContain('SA_RINCON')
})

test('candidate resolver uses the cache and fallbacks when nothing else matches', async () => {
	const cached = await collect(
		createSpotifyServiceCandidateResolver({
			favorites: [],
			listPlayerMetadataEntries: () => entries([]),
			listMusicServiceAccounts: async () => {
				throw new Error('not available')
			},
			readCachedServiceInfo: async () => ({
				sid: '12',
				sn: '6',
				descToken: 'SA_RINCON3079_X_#Svc3079-cached',
			}),
		}),
	)
	expect(cached[0]).toEqual({
		sid: '12',
		sn: '6',
		descToken: 'SA_RINCON3079_X_#Svc3079-cached',
		source: 'cache',
	})

	const resolver = createSpotifyServiceCandidateResolver({
		favorites: [],
		listPlayerMetadataEntries: () => entries([]),
		listMusicServiceAccounts: async () => [],
		readCachedServiceInfo: async () => null,
	})
	const fallbacks = await collect(resolver)
	expect(fallbacks).toEqual([
		{
			sid: '12',
			sn: '6',
			descToken: 'SA_RINCON3079_X_#Svc3079-0-Token',
			source: 'fallback',
		},
		{
			sid: '12',
			sn: '7',
			descToken: 'SA_RINCON3079_X_#Svc3079-0-Token',
			source: 'fallback',
		},
		{
			sid: '9',
			sn: '6',
			descToken: 'SA_RINCON2311_X_#Svc2311-0-Token',
			source: 'fallback',
		},
		{
			sid: '9',
			sn: '7',
			descToken: 'SA_RINCON2311_X_#Svc2311-0-Token',
			source: 'fallback',
		},
	])
	expect(resolver.tried).toEqual([
		'Sonos favorites (no Spotify favorite with service metadata)',
		'player now-playing/queue metadata (no Spotify item found)',
		'Sonos music-service account listing (no Spotify account)',
		'cached Spotify service info (empty)',
		'generic Spotify service fallbacks (sid=12 sn=6, sid=12 sn=7, sid=9 sn=6, sid=9 sn=7)',
	])
})

test('account listings and learned hints shape service info', () => {
	expect(
		getSpotifyServiceInfoFromAccounts([
			{ type: '519', serialNum: '1' },
			{ type: '2311', serialNum: '3' },
		]),
	).toEqual({
		sid: '9',
		sn: '3',
		descToken: 'SA_RINCON2311_X_#Svc2311-0-Token',
	})
	expect(
		getSpotifyServiceInfoFromAccounts([{ type: '519', serialNum: '1' }]),
	).toBe(null)
	expect(
		getSpotifyFallbackServiceInfos({ sn: '2' }).map(
			(info) => `${info.sid}/${info.sn}`,
		),
	).toEqual(['12/2', '12/6', '12/7', '9/2', '9/6', '9/7'])
})
