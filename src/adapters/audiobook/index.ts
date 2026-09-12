import { createWriteStream } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'
import {
	buildFfmetadata,
	buildFfmpegConvertArgs,
	runFfmpegCommand,
} from './ffmpeg.ts'
import {
	buildLibraryFilename,
	isWritableDirectory,
	pathExists,
	resolveLibraryRoot,
	resolveSafeLibraryFile,
} from './paths.ts'
import {
	AudiobookError,
	macAudiobookLibraryHostPath,
	synologyAudiobookLibraryHostPath,
	type AudiobookDecryptCredentials,
	type AudiobookExistsResult,
	type AudiobookFetch,
	type AudiobookImportInput,
	type AudiobookImportResult,
	type AudiobookLibraryStatus,
	type FfmpegRunner,
} from './types.ts'

export {
	AudiobookError,
	defaultAudiobookImportTimeoutMs,
	defaultAudiobookLibraryPath,
	defaultFfmpegPath,
	isAudiobookError,
	macAudiobookLibraryHostPath,
	synologyAudiobookLibraryHostPath,
} from './types.ts'
export {
	buildLibraryFilename,
	resolveSafeLibraryFile,
	sanitizeAudiobookFilename,
} from './paths.ts'
export { buildFfmpegConvertArgs } from './ffmpeg.ts'

type AudiobookErrorWithCaptureContext = AudiobookError & {
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext
}

function markExpected(error: AudiobookError) {
	const annotated = error as AudiobookErrorWithCaptureContext
	annotated.homeConnectorCaptureContext = {
		shouldCapture: false,
		tags: {
			connector_vendor: 'audiobook',
			audiobook_error_code: error.code,
		},
	}
	return error
}

function createAudiobookError(
	input: ConstructorParameters<typeof AudiobookError>[0],
) {
	return markExpected(new AudiobookError(input))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHexField(value: unknown) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (
		!/^[0-9a-fA-F]+$/.test(trimmed) ||
		trimmed.length < 8 ||
		trimmed.length % 2 !== 0
	) {
		return null
	}
	return trimmed.toLowerCase()
}

function readLicenseObject(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null
	if (
		isRecord(value.content_license) &&
		isRecord(value.content_license.license_response)
	) {
		return value.content_license.license_response
	}
	if (isRecord(value.license_response)) {
		return value.license_response
	}
	return value
}

export function parseAudiobookCredentials(input: {
	voucher?: unknown
	key?: string
	iv?: string
	activationBytes?: string
}): AudiobookDecryptCredentials {
	const activationBytes = input.activationBytes?.trim()
	if (activationBytes) {
		const parsed = readHexField(activationBytes)
		if (!parsed) {
			throw createAudiobookError({
				code: 'audiobook_credentials_invalid',
				message: 'activationBytes must be an even-length hex string.',
			})
		}
		return { kind: 'aax', activationBytes: parsed }
	}

	const key = input.key?.trim()
	const iv = input.iv?.trim()
	if (key || iv) {
		const parsedKey = readHexField(key)
		const parsedIv = readHexField(iv)
		if (!parsedKey || !parsedIv) {
			throw createAudiobookError({
				code: 'audiobook_credentials_invalid',
				message: 'key and iv must both be even-length hex strings.',
			})
		}
		return { kind: 'aaxc', key: parsedKey, iv: parsedIv }
	}

	if (input.voucher == null) {
		throw createAudiobookError({
			code: 'audiobook_credentials_invalid',
			message:
				'Provide a voucher (or voucherPath), key+iv, or activationBytes. Home-connector does not talk to Audible.',
		})
	}

	let voucher = input.voucher
	if (typeof voucher === 'string') {
		try {
			voucher = JSON.parse(voucher) as unknown
		} catch {
			throw createAudiobookError({
				code: 'audiobook_credentials_invalid',
				message:
					'voucher must be JSON containing license_response.key and .iv.',
			})
		}
	}

	const license = readLicenseObject(voucher)
	const parsedKey = readHexField(license?.key)
	const parsedIv = readHexField(license?.iv)
	if (!parsedKey || !parsedIv) {
		throw createAudiobookError({
			code: 'audiobook_credentials_invalid',
			message:
				'voucher must include content_license.license_response.key and .iv (hex).',
		})
	}
	return { kind: 'aaxc', key: parsedKey, iv: parsedIv }
}

async function downloadAaxc(input: {
	url: string
	destPath: string
	fetchImpl: AudiobookFetch
}) {
	let parsed: URL
	try {
		parsed = new URL(input.url)
	} catch {
		throw createAudiobookError({
			code: 'audiobook_download_failed',
			message: 'aaxcUrl is not a valid URL.',
		})
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw createAudiobookError({
			code: 'audiobook_download_failed',
			message: 'aaxcUrl must be http or https.',
		})
	}

	let response: Response
	try {
		response = await input.fetchImpl(input.url)
	} catch (error) {
		throw createAudiobookError({
			code: 'audiobook_download_failed',
			message: `Failed to download AAXC: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
	if (!response.ok) {
		throw createAudiobookError({
			code: 'audiobook_download_failed',
			message: `Failed to download AAXC: HTTP ${response.status}.`,
		})
	}
	if (!response.body) {
		throw createAudiobookError({
			code: 'audiobook_download_failed',
			message: 'Failed to download AAXC: empty response body.',
		})
	}

	try {
		await pipeline(
			Readable.fromWeb(response.body as WebReadableStream),
			createWriteStream(input.destPath),
		)
	} catch (error) {
		await rm(input.destPath, { force: true })
		throw createAudiobookError({
			code: 'audiobook_download_failed',
			message: `Failed to write downloaded AAXC: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

async function probeFfmpeg(input: {
	ffmpegPath: string
	runFfmpeg: FfmpegRunner
}) {
	try {
		const result = await input.runFfmpeg({
			command: input.ffmpegPath,
			args: ['-version'],
			timeoutMs: 5_000,
		})
		return result.exitCode === 0
	} catch {
		return false
	}
}

export function createAudiobookAdapter(input: {
	config: HomeConnectorConfig
	runFfmpeg?: FfmpegRunner
	fetchImpl?: AudiobookFetch
	probeFfmpeg?: () => Promise<boolean>
}) {
	const runFfmpeg = input.runFfmpeg ?? runFfmpegCommand
	const fetchImpl = input.fetchImpl ?? fetch
	const ffmpegPath = input.config.ffmpegPath
	const libraryPath = input.config.audiobookLibraryPath
	const importTimeoutMs = input.config.audiobookImportTimeoutMs

	async function checkFfmpegAvailable() {
		if (input.probeFfmpeg) return await input.probeFfmpeg()
		return await probeFfmpeg({ ffmpegPath, runFfmpeg })
	}

	async function getLibraryStatus(): Promise<AudiobookLibraryStatus> {
		let exists = false
		let writable = false
		try {
			const root = await resolveLibraryRoot(libraryPath)
			exists = true
			writable = await isWritableDirectory(root)
		} catch {
			exists = false
			writable = false
		}
		return {
			libraryPath: libraryPath,
			hostPaths: {
				synology: synologyAudiobookLibraryHostPath,
				mac: macAudiobookLibraryHostPath,
			},
			exists,
			writable,
			ffmpegAvailable: await checkFfmpegAvailable(),
			ffmpegPath,
		}
	}

	async function exists(rawFilename: string): Promise<AudiobookExistsResult> {
		const root = await resolveLibraryRoot(libraryPath)
		const target = resolveSafeLibraryFile(root, rawFilename)
		return {
			filename: target.filename,
			path: target.path,
			exists: await pathExists(target.path),
		}
	}

	function resolveOutputFilename(request: AudiobookImportInput) {
		if (request.outputFilename?.trim()) {
			return request.outputFilename.trim()
		}
		if (request.title?.trim()) {
			return buildLibraryFilename(request.title)
		}
		throw createAudiobookError({
			code: 'audiobook_path_invalid',
			message:
				'Provide title (preferred) or outputFilename for the library file.',
		})
	}

	async function importAaxc(
		request: AudiobookImportInput,
	): Promise<AudiobookImportResult> {
		const sourceCount =
			Number(Boolean(request.aaxcPath?.trim())) +
			Number(Boolean(request.aaxcUrl?.trim())) +
			Number(Boolean(request.aaxcBase64?.trim()))
		if (sourceCount !== 1) {
			throw createAudiobookError({
				code: 'audiobook_source_missing',
				message:
					'Provide exactly one of aaxcPath (temp path), aaxcBase64 (AAXC bytes), or aaxcUrl.',
			})
		}

		let voucher = request.voucher
		if (request.voucherPath?.trim()) {
			try {
				voucher = await readFile(request.voucherPath.trim(), 'utf8')
			} catch {
				throw createAudiobookError({
					code: 'audiobook_credentials_invalid',
					message: `voucherPath is not readable: ${request.voucherPath}`,
					path: request.voucherPath,
				})
			}
		}

		const credentials = parseAudiobookCredentials({
			voucher,
			key: request.key,
			iv: request.iv,
			activationBytes: request.activationBytes,
		})

		const root = await resolveLibraryRoot(libraryPath)
		if (!(await isWritableDirectory(root))) {
			throw createAudiobookError({
				code: 'audiobook_library_not_writable',
				message: `Audiobook library is not writable: ${root}`,
				path: root,
			})
		}

		const target = resolveSafeLibraryFile(root, resolveOutputFilename(request))
		const alreadyExists = await pathExists(target.path)
		if (alreadyExists && !request.overwrite) {
			throw createAudiobookError({
				code: 'audiobook_already_exists',
				message: `${target.filename} already exists in the audiobook library. Pass overwrite=true to replace it.`,
				filename: target.filename,
				path: target.path,
			})
		}

		if (!(await checkFfmpegAvailable())) {
			throw createAudiobookError({
				code: 'audiobook_ffmpeg_unavailable',
				message: `ffmpeg is not available at ${ffmpegPath}. The home-connector image must include ffmpeg.`,
			})
		}

		const downloadedPath = `${target.path}.partial.aaxc`
		const convertPath = `${target.path}.partial.m4b`
		const metadataPath = `${target.path}.ffmetadata`
		const coverDestPath = `${target.path}.cover`
		let sourcePath = request.aaxcPath?.trim() ?? ''
		let source: 'path' | 'url' | 'bytes' = 'path'
		let downloaded = false
		let metadataWritten = false
		let coverWritten = false
		const chapters = request.chapters ?? []
		const hasChapters = chapters.length > 0
		const hasCover = Boolean(
			request.coverBase64?.trim() || request.coverPath?.trim(),
		)

		try {
			if (request.aaxcUrl?.trim()) {
				source = 'url'
				downloaded = true
				await downloadAaxc({
					url: request.aaxcUrl.trim(),
					destPath: downloadedPath,
					fetchImpl,
				})
				sourcePath = downloadedPath
			} else if (request.aaxcBase64?.trim()) {
				source = 'bytes'
				downloaded = true
				let bytes: Buffer
				try {
					bytes = Buffer.from(request.aaxcBase64.trim(), 'base64')
				} catch {
					throw createAudiobookError({
						code: 'audiobook_source_missing',
						message: 'aaxcBase64 is not valid base64.',
					})
				}
				if (bytes.length === 0) {
					throw createAudiobookError({
						code: 'audiobook_source_missing',
						message: 'aaxcBase64 decoded to an empty payload.',
					})
				}
				await writeFile(downloadedPath, bytes)
				sourcePath = downloadedPath
			} else if (!(await pathExists(sourcePath))) {
				throw createAudiobookError({
					code: 'audiobook_source_missing',
					message: `aaxcPath does not exist: ${sourcePath}`,
					path: sourcePath,
				})
			}

			let resolvedCoverPath: string | undefined
			if (request.coverPath?.trim()) {
				if (!(await pathExists(request.coverPath.trim()))) {
					throw createAudiobookError({
						code: 'audiobook_cover_invalid',
						message: `coverPath does not exist: ${request.coverPath}`,
						path: request.coverPath,
					})
				}
				resolvedCoverPath = request.coverPath.trim()
			} else if (request.coverBase64?.trim()) {
				let coverBytes: Buffer
				try {
					coverBytes = Buffer.from(request.coverBase64.trim(), 'base64')
				} catch {
					throw createAudiobookError({
						code: 'audiobook_cover_invalid',
						message: 'coverBase64 is not valid base64.',
					})
				}
				if (coverBytes.length === 0 || coverBytes.length > 10 * 1024 * 1024) {
					throw createAudiobookError({
						code: 'audiobook_cover_invalid',
						message: 'coverBase64 must decode to a non-empty image under 10MB.',
					})
				}
				await writeFile(coverDestPath, coverBytes)
				coverWritten = true
				resolvedCoverPath = coverDestPath
			}

			let resolvedMetadataPath: string | undefined
			if (hasChapters) {
				await writeFile(
					metadataPath,
					buildFfmetadata({
						title: request.title,
						chapters,
					}),
				)
				metadataWritten = true
				resolvedMetadataPath = metadataPath
			}

			const result = await runFfmpeg({
				command: ffmpegPath,
				args: buildFfmpegConvertArgs({
					credentials,
					sourcePath,
					outputPath: convertPath,
					metadataPath: resolvedMetadataPath,
					coverPath: resolvedCoverPath,
					title: request.title,
				}),
				timeoutMs: importTimeoutMs,
			})
			if (result.timedOut) {
				throw createAudiobookError({
					code: 'audiobook_ffmpeg_failed',
					message: `ffmpeg timed out after ${importTimeoutMs}ms.`,
					filename: target.filename,
				})
			}
			if (result.exitCode !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim()
				throw createAudiobookError({
					code: 'audiobook_ffmpeg_failed',
					message: `ffmpeg failed with exit code ${String(result.exitCode)}.${detail ? ` ${detail}` : ''}`,
					filename: target.filename,
				})
			}
			if (!(await pathExists(convertPath))) {
				throw createAudiobookError({
					code: 'audiobook_ffmpeg_failed',
					message: 'ffmpeg exited 0 but did not write the M4B output.',
					filename: target.filename,
				})
			}

			await rename(convertPath, target.path)
			const outputStat = await stat(target.path)
			return {
				filename: target.filename,
				path: target.path,
				bytes: outputStat.size,
				overwritten: alreadyExists,
				source,
				chapters: chapters.length,
				coverAttached: hasCover,
			}
		} finally {
			await rm(convertPath, { force: true })
			if (downloaded) {
				await rm(downloadedPath, { force: true })
			}
			if (metadataWritten) {
				await rm(metadataPath, { force: true })
			}
			if (coverWritten) {
				await rm(coverDestPath, { force: true })
			}
		}
	}

	function libraryFilename(title: string) {
		const filename = buildLibraryFilename(title)
		return { title: title.trim(), filename }
	}

	return {
		getLibraryStatus,
		exists,
		libraryFilename,
		importAaxc,
	}
}

export type createAudiobookAdapter = ReturnType<typeof createAudiobookAdapter>
