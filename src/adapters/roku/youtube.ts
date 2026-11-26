// YouTube's Roku channel id. Deep link: POST /launch/837?contentId=<videoId>.
export const ROKU_YOUTUBE_APP_ID = '837'

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/

const youTubeHosts = new Set([
	'youtube.com',
	'www.youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtube-nocookie.com',
	'www.youtube-nocookie.com',
	'youtu.be',
	'www.youtu.be',
])

const pathPrefixes = ['shorts', 'live', 'embed', 'v', 'e']

function toVideoId(candidate: string | null | undefined) {
	const trimmed = candidate?.trim() ?? ''
	return videoIdPattern.test(trimmed) ? trimmed : null
}

/**
 * Extracts an 11-character YouTube video id from a YouTube URL or bare id.
 * Throws for non-YouTube hosts and playlist-only links.
 */
export function parseYouTubeVideoId(input: string): string {
	const raw = input.trim()
	if (!raw) {
		throw new Error('A YouTube URL or video id is required.')
	}
	const bareId = toVideoId(raw)
	if (bareId) return bareId

	let url: URL
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
	} catch {
		throw new Error(`"${raw}" is not a YouTube URL or 11-character video id.`)
	}
	const host = url.hostname.toLowerCase()
	if (!youTubeHosts.has(host)) {
		throw new Error(
			`"${url.hostname}" is not a YouTube host. Pass a youtube.com or youtu.be link.`,
		)
	}

	const segments = url.pathname.split('/').filter(Boolean)
	let videoId: string | null = null
	if (host === 'youtu.be' || host === 'www.youtu.be') {
		videoId = toVideoId(segments[0])
	} else if (segments[0] === 'watch') {
		videoId = toVideoId(url.searchParams.get('v'))
	} else if (segments[0] && pathPrefixes.includes(segments[0])) {
		videoId = toVideoId(segments[1])
	}
	if (videoId) return videoId

	if (url.searchParams.has('list')) {
		throw new Error(
			`"${raw}" is a playlist link without a video id. Pass a link to a specific video.`,
		)
	}
	throw new Error(`Could not find a YouTube video id in "${raw}".`)
}
