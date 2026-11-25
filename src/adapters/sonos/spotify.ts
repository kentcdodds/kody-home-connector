import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'
import { decodeXmlEntities, encodeXml } from './soap-client.ts'
import { type SonosFavorite } from './types.ts'

const spotifyContentKinds = [
	'album',
	'artist',
	'concert',
	'episode',
	'playlist',
	'show',
	'track',
] as const

export type SpotifyContentKind = (typeof spotifyContentKinds)[number]

type SpotifyContainerKind = 'album' | 'artist' | 'playlist' | 'show'
type SpotifyItemKind = 'episode' | 'track'

export type SpotifyContentParts = {
	kind: SpotifyContentKind
	id: string
	spotifyUri: string
}

export type SpotifyServiceInfo = {
	sid: string
	sn: string
	descToken: string
}

export type SpotifyServiceSource =
	| 'favorite'
	| 'player'
	| 'account'
	| 'cache'
	| 'fallback'

export type SpotifyServiceCandidate = SpotifyServiceInfo & {
	source: SpotifyServiceSource
}

export type SpotifyMetadataEntry = {
	uri: string | null
	metadata: string | null
}

export type SonosMusicServiceAccount = {
	type: string
	serialNum: string
}

type SpotifyContainerConfig = {
	prefix: string
	flags: string
	className: string
	/** Spotify URI kind Sonos expects inside the container id. */
	sonosKind: string
}

const defaultSpotifyContainerConfig = {
	playlist: {
		prefix: '1006286c',
		flags: '10348',
		className: 'object.container.playlistContainer',
		sonosKind: 'playlist',
	},
	album: {
		prefix: '1004006c',
		flags: '108',
		className: 'object.container.album.musicAlbum',
		sonosKind: 'album',
	},
	// Sonos has no queue-able "artist" container; artist top tracks is the
	// native equivalent (node-sonos-ts encoding). Artist radio
	// (x-sonosapi-radio:spotify%3aartistRadio%3a…) is a stream, not a queue.
	artist: {
		prefix: '100e206c',
		flags: '8300',
		className: 'object.container.playlistContainer',
		sonosKind: 'artistTopTracks',
	},
	// Podcast shows queue like playlists (SoCo/node-sonos-ts encoding).
	show: {
		prefix: '1006206c',
		flags: '8300',
		className: 'object.container.playlistContainer',
		sonosKind: 'show',
	},
} satisfies Record<SpotifyContainerKind, SpotifyContainerConfig>

const defaultSpotifyItemConfig = {
	flags: '8224',
	className: 'object.item.audioItem.musicTrack',
}

/** Sonos Spotify service ids, most likely first (12 is current, 9 legacy). */
export const knownSpotifyServiceIds = ['12', '9'] as const
/** Account serial numbers tried when none can be learned (6 is this house). */
export const defaultSpotifyServiceSerialNumbers = ['6', '7'] as const

export function isSpotifyContentUri(uri: string) {
	return /^spotify:[A-Za-z]+:[A-Za-z0-9]+$/.test(uri.trim())
}

export function parseSpotifyUri(uri: string): SpotifyContentParts | null {
	const match = uri.trim().match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/)
	if (!match) return null
	const [, kind, id] = match
	if (!(spotifyContentKinds as ReadonlyArray<string>).includes(kind)) {
		return null
	}
	return {
		kind: kind as SpotifyContentKind,
		id,
		spotifyUri: `spotify:${kind}:${id}`,
	}
}

function createSpotifyCallerError(message: string, code: string) {
	const error = new Error(message) as Error & {
		homeConnectorCaptureContext: HomeConnectorErrorCaptureContext
	}
	error.name = 'SonosCallerError'
	error.homeConnectorCaptureContext = {
		shouldCapture: false,
		tags: {
			connector_vendor: 'sonos',
			sonos_caller_error: code,
		},
	}
	return error
}

export function assertPlayableSpotifyContent(spotify: SpotifyContentParts) {
	if (spotify.kind === 'concert') {
		throw createSpotifyCallerError(
			`Spotify concert links (${spotify.spotifyUri}) are event listings and are not playable on Sonos. Use a Spotify album, playlist, track, artist, show, or episode URI instead.`,
			'spotify_concert_unplayable',
		)
	}
}

export function createSpotifyMetadataUnavailableError(tried: Array<string>) {
	const triedSummary = tried.length ? ` Tried: ${tried.join('; ')}.` : ''
	return createSpotifyCallerError(
		`Unable to build Sonos Spotify metadata because no Spotify service account info (sid/sn/desc token) could be resolved.${triedSummary} Add any Spotify item to Sonos Favorites, or pass a Sonos content URI and DIDL metadata explicitly.`,
		'spotify_metadata_unavailable',
	)
}

function getQueryParam(uri: string, name: string) {
	const query = decodeXmlEntities(uri).split('#')[0]?.split('?')[1]
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

function isSpotifyServiceUri(uri: string | null) {
	const normalizedUri = uri?.toLowerCase() ?? ''
	return (
		normalizedUri.includes('spotify%3a') ||
		normalizedUri.startsWith('x-sonos-spotify:')
	)
}

/** Sonos account type for a music service id (`sid * 256 + 7`). */
function getSonosServiceType(sid: string) {
	return String(Number(sid) * 256 + 7)
}

function getSonosServiceIdFromType(type: string) {
	const sid = (Number(type) - 7) / 256
	return Number.isInteger(sid) && sid > 0 ? String(sid) : null
}

/**
 * Generic per-service desc token (`SA_RINCON3079_X_#Svc3079-0-Token` for sid
 * 12) used by SoCo/node-sonos-ts when no account-specific token is known.
 */
export function buildGenericSpotifyDescToken(sid: string) {
	const type = getSonosServiceType(sid)
	return `SA_RINCON${type}_X_#Svc${type}-0-Token`
}

/**
 * Reads sid/sn/desc token from Sonos URIs + DIDL metadata (favorites, queue,
 * now playing). With `deriveMissingToken`, entries that carry sid/sn but no
 * desc (e.g. queue browse results) use the generic token for that sid.
 */
export function getSpotifyServiceInfoFromEntries(
	entries: Array<SpotifyMetadataEntry>,
	options: { deriveMissingToken?: boolean } = {},
): SpotifyServiceInfo | null {
	for (const entry of entries) {
		if (!entry.uri || !isSpotifyServiceUri(entry.uri)) continue
		const sn = getQueryParam(entry.uri, 'sn')
		if (!sn) continue
		const sid = getQueryParam(entry.uri, 'sid') ?? '12'
		const descToken =
			extractSpotifyDescToken(entry.metadata) ??
			(options.deriveMissingToken ? buildGenericSpotifyDescToken(sid) : null)
		if (descToken) return { sid, sn, descToken }
	}
	return null
}

export function getSpotifyServiceInfoFromAccounts(
	accounts: Array<SonosMusicServiceAccount>,
): SpotifyServiceInfo | null {
	for (const sid of knownSpotifyServiceIds) {
		const type = getSonosServiceType(sid)
		const account = accounts.find((entry) => entry.type === type)
		if (account?.serialNum) {
			return {
				sid,
				sn: account.serialNum,
				descToken: buildGenericSpotifyDescToken(sid),
			}
		}
	}
	return null
}

export function getSpotifyFallbackServiceInfos(
	hints: { sid?: string | null; sn?: string | null } = {},
): Array<SpotifyServiceInfo> {
	const sids = unique([hints.sid, ...knownSpotifyServiceIds])
	const sns = unique([hints.sn, ...defaultSpotifyServiceSerialNumbers])
	return sids.flatMap((sid) =>
		sns.map((sn) => ({
			sid,
			sn,
			descToken: buildGenericSpotifyDescToken(sid),
		})),
	)
}

function unique(values: Array<string | null | undefined>) {
	return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function getServiceInfoKey(info: SpotifyServiceInfo) {
	return `${info.sid}|${info.sn}|${info.descToken}`
}

/**
 * Yields Spotify service info candidates in priority order: favorites,
 * household player metadata, Sonos account listing, the SQLite cache, then
 * generic fallbacks. Later sources are only consulted when the caller asks
 * for another candidate. `tried` describes each source without tokens.
 */
export function createSpotifyServiceCandidateResolver(deps: {
	favorites: Array<SonosFavorite>
	listPlayerMetadataEntries: () => AsyncIterable<SpotifyMetadataEntry>
	listMusicServiceAccounts: () => Promise<Array<SonosMusicServiceAccount>>
	readCachedServiceInfo: () => Promise<SpotifyServiceInfo | null>
}) {
	const tried: Array<string> = []
	const seen = new Set<string>()
	const hints: { sid?: string | null; sn?: string | null } = {}

	function* emit(
		info: SpotifyServiceInfo | null,
		source: SpotifyServiceSource,
	): Generator<SpotifyServiceCandidate> {
		if (!info) return
		hints.sid ??= info.sid
		hints.sn ??= info.sn
		const key = getServiceInfoKey(info)
		if (seen.has(key)) return
		seen.add(key)
		yield { ...info, source }
	}

	async function* candidates(): AsyncGenerator<SpotifyServiceCandidate> {
		const fromFavorites = getSpotifyServiceInfoFromEntries(deps.favorites)
		tried.push(
			fromFavorites
				? 'Spotify favorite'
				: 'Sonos favorites (no Spotify favorite with service metadata)',
		)
		yield* emit(fromFavorites, 'favorite')

		// Every distinct hint is offered, so a rejected stale account does not
		// hide a working one later in the queue.
		let foundPlayerHint = false
		try {
			for await (const entry of deps.listPlayerMetadataEntries()) {
				const fromPlayer = getSpotifyServiceInfoFromEntries([entry], {
					deriveMissingToken: true,
				})
				if (!fromPlayer) continue
				foundPlayerHint = true
				yield* emit(fromPlayer, 'player')
			}
			tried.push(
				foundPlayerHint
					? 'player now-playing/queue metadata'
					: 'player now-playing/queue metadata (no Spotify item found)',
			)
		} catch {
			tried.push('player now-playing/queue metadata (unavailable)')
		}

		let fromAccounts: SpotifyServiceInfo | null = null
		try {
			const accounts = await deps.listMusicServiceAccounts()
			fromAccounts = getSpotifyServiceInfoFromAccounts(accounts)
			const spotifySid = accounts
				.map((account) => getSonosServiceIdFromType(account.type))
				.find((sid) =>
					(knownSpotifyServiceIds as ReadonlyArray<string | null>).includes(
						sid,
					),
				)
			hints.sid ??= spotifySid
			tried.push(
				fromAccounts
					? 'Sonos music-service account listing'
					: 'Sonos music-service account listing (no Spotify account)',
			)
		} catch {
			tried.push('Sonos music-service account listing (unavailable)')
		}
		yield* emit(fromAccounts, 'account')

		let fromCache: SpotifyServiceInfo | null = null
		try {
			fromCache = await deps.readCachedServiceInfo()
			tried.push(
				fromCache
					? 'cached Spotify service info'
					: 'cached Spotify service info (empty)',
			)
		} catch {
			tried.push('cached Spotify service info (unavailable)')
		}
		yield* emit(fromCache, 'cache')

		const fallbacks = getSpotifyFallbackServiceInfos(hints)
		tried.push(
			`generic Spotify service fallbacks (${fallbacks
				.map((info) => `sid=${info.sid} sn=${info.sn}`)
				.join(', ')})`,
		)
		for (const info of fallbacks) {
			yield* emit(info, 'fallback')
		}
	}

	return { candidates: candidates(), tried }
}

function getContainerConfigFromFavorites(
	favorites: Array<SonosFavorite>,
	kind: SpotifyContainerKind,
) {
	const defaults = defaultSpotifyContainerConfig[kind]
	for (const favorite of favorites) {
		if (!favorite.uri?.startsWith('x-rincon-cpcontainer:')) continue
		const marker = `spotify%3A${defaults.sonosKind}%3A`
		const markerIndex = favorite.uri.toLowerCase().indexOf(marker.toLowerCase())
		if (markerIndex === -1) continue
		const prefix = favorite.uri.slice(
			'x-rincon-cpcontainer:'.length,
			markerIndex,
		)
		const flags = getQueryParam(favorite.uri, 'flags')
		if (prefix && flags) {
			return { ...defaults, prefix, flags }
		}
	}
	return defaults
}

function buildSpotifyDidl(input: {
	contentId: string
	spotifyUri: string
	className: string
	descToken: string
}) {
	return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${encodeXml(input.contentId)}" parentID="${encodeXml(input.contentId)}" restricted="true"><dc:title>${encodeXml(input.spotifyUri)}</dc:title><upnp:class>${input.className}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${encodeXml(input.descToken)}</desc></item></DIDL-Lite>`
}

function isSpotifyItemKind(kind: SpotifyContentKind): kind is SpotifyItemKind {
	return kind === 'track' || kind === 'episode'
}

/**
 * Builds a Sonos queue URI + DIDL for a bare `spotify:<kind>:<id>` URI.
 * Service info comes from `serviceInfo` when given, else from a Spotify
 * favorite. Returns null for non-Spotify or unsupported Spotify URIs.
 */
export function buildSonosSpotifyUri(input: {
	uri: string
	favorites: Array<SonosFavorite>
	serviceInfo?: SpotifyServiceInfo | null
}): { uri: string; metadata: string } | null {
	const spotify = parseSpotifyUri(input.uri)
	if (!spotify) return null
	assertPlayableSpotifyContent(spotify)
	const kind = spotify.kind as SpotifyContainerKind | SpotifyItemKind
	const serviceInfo =
		input.serviceInfo ?? getSpotifyServiceInfoFromEntries(input.favorites)
	if (!serviceInfo) {
		throw createSpotifyMetadataUnavailableError([
			'Sonos favorites (no Spotify favorite with service metadata)',
		])
	}
	if (isSpotifyItemKind(kind)) {
		const encodedSpotifyUri = encodeURIComponent(spotify.spotifyUri)
		return {
			uri: `x-sonos-spotify:${encodedSpotifyUri}?sid=${serviceInfo.sid}&flags=${defaultSpotifyItemConfig.flags}&sn=${serviceInfo.sn}`,
			metadata: buildSpotifyDidl({
				contentId: encodedSpotifyUri,
				spotifyUri: spotify.spotifyUri,
				className: defaultSpotifyItemConfig.className,
				descToken: serviceInfo.descToken,
			}),
		}
	}
	const containerConfig = getContainerConfigFromFavorites(input.favorites, kind)
	const sonosSpotifyUri = `spotify:${containerConfig.sonosKind}:${spotify.id}`
	const contentId = `${containerConfig.prefix}${encodeURIComponent(sonosSpotifyUri)}`
	return {
		uri: `x-rincon-cpcontainer:${contentId}?sid=${serviceInfo.sid}&flags=${containerConfig.flags}&sn=${serviceInfo.sn}`,
		metadata: buildSpotifyDidl({
			contentId,
			spotifyUri: spotify.spotifyUri,
			className: containerConfig.className,
			descToken: serviceInfo.descToken,
		}),
	}
}
