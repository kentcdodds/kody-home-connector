export const defaultAudiobookLibraryPath = '/media/audiobooks'
export const defaultFfmpegPath = 'ffmpeg'
export const defaultAudiobookImportTimeoutMs = 30 * 60 * 1000

/** Synology host path for Kent's NAS pull (mounted RW at `/media/audiobooks`). */
export const synologyAudiobookLibraryHostPath =
	'/volume1/media/audio/audiobooks'

/** macOS mount of the same share. */
export const macAudiobookLibraryHostPath = '/Volumes/media/audio/audiobooks'

export const audiobookErrorCodes = [
	'audiobook_library_unavailable',
	'audiobook_library_not_writable',
	'audiobook_path_invalid',
	'audiobook_already_exists',
	'audiobook_source_missing',
	'audiobook_credentials_invalid',
	'audiobook_ffmpeg_unavailable',
	'audiobook_ffmpeg_failed',
	'audiobook_download_failed',
	'audiobook_cover_invalid',
] as const

export type AudiobookErrorCode = (typeof audiobookErrorCodes)[number]

export type AudiobookDecryptCredentials =
	| { kind: 'aaxc'; key: string; iv: string }
	| { kind: 'aax'; activationBytes: string }

export type AudiobookLibraryStatus = {
	libraryPath: string
	hostPaths: {
		synology: string
		mac: string
	}
	exists: boolean
	writable: boolean
	ffmpegAvailable: boolean
	ffmpegPath: string
}

export type AudiobookExistsResult = {
	filename: string
	path: string
	exists: boolean
}

export type AudiobookChapter = {
	title: string
	startMs?: number
	start_offset_ms?: number
	endMs?: number
	lengthMs?: number
	length_ms?: number
}

export type AudiobookImportInput = {
	aaxcPath?: string
	aaxcUrl?: string
	aaxcBase64?: string
	voucher?: unknown
	voucherPath?: string
	key?: string
	iv?: string
	activationBytes?: string
	title?: string
	outputFilename?: string
	chapters?: Array<AudiobookChapter>
	coverBase64?: string
	coverPath?: string
	overwrite?: boolean
}

export type AudiobookImportResult = {
	filename: string
	path: string
	bytes: number
	overwritten: boolean
	source: 'path' | 'url' | 'bytes'
	chapters: number
	coverAttached: boolean
}

export type FfmpegRunResult = {
	stdout: string
	stderr: string
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
}

export type FfmpegRunner = (input: {
	command: string
	args: Array<string>
	timeoutMs: number
}) => Promise<FfmpegRunResult>

export type AudiobookFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>

export class AudiobookError extends Error {
	readonly code: AudiobookErrorCode
	readonly path?: string
	readonly filename?: string

	constructor(input: {
		code: AudiobookErrorCode
		message: string
		path?: string
		filename?: string
	}) {
		super(input.message)
		this.name = 'AudiobookError'
		this.code = input.code
		this.path = input.path
		this.filename = input.filename
	}
}

export function isAudiobookError(error: unknown): error is AudiobookError {
	return error instanceof AudiobookError
}
