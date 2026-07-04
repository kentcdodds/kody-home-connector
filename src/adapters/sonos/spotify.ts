import { decodeXmlEntities, encodeXml } from './soap-client.ts'
import { type SonosFavorite } from './types.ts'

type SpotifyContentKind = 'album' | 'playlist' | 'track'

type SpotifyContentParts = {
	kind: SpotifyContentKind
	id: string
	spotifyUri: string
}

type SpotifyServiceInfo = {
	sid: string
	sn: string
	descToken: string
}

const defaultSpotifyContainerConfig = {
	playlist: {
		prefix: '1006286c',
		flags: '10348',
		className: 'object.container.playlistContainer',
	},
	album: {
		prefix: '1004006c',
		flags: '108',
		className: 'object.container.album.musicAlbum',
	},
} satisfies Record<
	Exclude<SpotifyContentKind, 'track'>,
	{
		prefix: string
		flags: string
		className: string
	}
>

const defaultSpotifyTrackConfig = {
	flags: '8224',
	className: 'object.item.audioItem.musicTrack',
}

function parseSpotifyUri(uri: string): SpotifyContentParts | null {
	const match = uri
		.trim()
		.match(/^spotify:(playlist|album|track):([A-Za-z0-9]+)$/)
	if (!match) return null
	const [, kind, id] = match
	return {
		kind: kind as SpotifyContentKind,
		id,
		spotifyUri: `spotify:${kind}:${id}`,
	}
}

function getQueryParam(uri: string, name: string) {
	const query = uri.split('?')[1]
	if (!query) return null
	return new URLSearchParams(query).get(name)
}

function extractSpotifyDescToken(metadata: string | null) {
	if (!metadata) return null
	const xml = decodeXmlEntities(metadata)
	return (
		xml.match(
			/<desc\b[^>]*nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0\/"[^>]*>([\s\S]*?)<\/desc>/i,
		)?.[1] ??
		xml.match(/<desc\b[^>]*>(SA_RINCON[\s\S]*?)<\/desc>/i)?.[1] ??
		null
	)
}

function isSpotifyFavoriteUri(uri: string | null) {
	const normalizedUri = uri?.toLowerCase() ?? ''
	return (
		normalizedUri.includes('spotify%3a') ||
		normalizedUri.startsWith('x-sonos-spotify:')
	)
}

function getSpotifyFavoriteServiceInfo(
	favorites: Array<SonosFavorite>,
): SpotifyServiceInfo | null {
	for (const favorite of favorites) {
		if (!isSpotifyFavoriteUri(favorite.uri)) continue
		const descToken = extractSpotifyDescToken(favorite.metadata)
		const sn = favorite.uri ? getQueryParam(favorite.uri, 'sn') : null
		const sid = favorite.uri ? getQueryParam(favorite.uri, 'sid') : null
		if (descToken && sn) {
			return {
				descToken,
				sn,
				sid: sid ?? '12',
			}
		}
	}
	return null
}

function getContainerConfigFromFavorites(
	favorites: Array<SonosFavorite>,
	kind: Exclude<SpotifyContentKind, 'track'>,
) {
	for (const favorite of favorites) {
		if (!favorite.uri?.startsWith('x-rincon-cpcontainer:')) continue
		const marker = `spotify%3A${kind}%3A`
		const markerIndex = favorite.uri.toLowerCase().indexOf(marker.toLowerCase())
		if (markerIndex === -1) continue
		const prefix = favorite.uri.slice(
			'x-rincon-cpcontainer:'.length,
			markerIndex,
		)
		const flags = getQueryParam(favorite.uri, 'flags')
		if (prefix && flags) {
			return {
				prefix,
				flags,
			}
		}
	}
	return {
		prefix: defaultSpotifyContainerConfig[kind].prefix,
		flags: defaultSpotifyContainerConfig[kind].flags,
	}
}

function buildSpotifyDidl(input: {
	contentId: string
	spotifyUri: string
	className: string
	descToken: string
}) {
	return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${encodeXml(input.contentId)}" parentID="${encodeXml(input.contentId)}" restricted="true"><dc:title>${encodeXml(input.spotifyUri)}</dc:title><upnp:class>${input.className}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${encodeXml(input.descToken)}</desc></item></DIDL-Lite>`
}

export function buildSonosSpotifyUri(input: {
	uri: string
	favorites: Array<SonosFavorite>
}): { uri: string; metadata: string } | null {
	const spotify = parseSpotifyUri(input.uri)
	if (!spotify) return null
	const serviceInfo = getSpotifyFavoriteServiceInfo(input.favorites)
	if (!serviceInfo) {
		throw new Error(
			'Unable to build Sonos Spotify metadata because no existing Spotify favorite with service metadata was found. Pass a Sonos content URI and DIDL metadata explicitly.',
		)
	}
	const encodedSpotifyUri = encodeURIComponent(spotify.spotifyUri)
	if (spotify.kind === 'track') {
		const uri = `x-sonos-spotify:${encodedSpotifyUri}?sid=${serviceInfo.sid}&flags=${defaultSpotifyTrackConfig.flags}&sn=${serviceInfo.sn}`
		return {
			uri,
			metadata: buildSpotifyDidl({
				contentId: encodedSpotifyUri,
				spotifyUri: spotify.spotifyUri,
				className: defaultSpotifyTrackConfig.className,
				descToken: serviceInfo.descToken,
			}),
		}
	}
	const containerConfig = getContainerConfigFromFavorites(
		input.favorites,
		spotify.kind,
	)
	const contentId = `${containerConfig.prefix}${encodedSpotifyUri}`
	return {
		uri: `x-rincon-cpcontainer:${contentId}?sid=${serviceInfo.sid}&flags=${containerConfig.flags}&sn=${serviceInfo.sn}`,
		metadata: buildSpotifyDidl({
			contentId,
			spotifyUri: spotify.spotifyUri,
			className: defaultSpotifyContainerConfig[spotify.kind].className,
			descToken: serviceInfo.descToken,
		}),
	}
}
