import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import {
	buildLibraryFilename,
	createAudiobookAdapter,
	parseAudiobookCredentials,
	sanitizeAudiobookFilename,
} from './index.ts'
import { resolvePathInsideLibrary, resolveSafeLibraryFile } from './paths.ts'
import { buildFfmetadata, buildFfmpegConvertArgs } from './ffmpeg.ts'
import { AudiobookError } from './types.ts'

const sampleKey = '0123456789abcdef0123456789abcdef'
const sampleIv = 'fedcba9876543210fedcba9876543210'

async function withLibrary<T>(
	run: (libraryPath: string) => Promise<T>,
): Promise<T> {
	const libraryPath = await mkdtemp(path.join(tmpdir(), 'audiobook-library-'))
	try {
		return await run(libraryPath)
	} finally {
		await rm(libraryPath, { recursive: true, force: true })
	}
}

function createAdapter(
	libraryPath: string,
	options: {
		writeOutput?: boolean
		ffmpegExitCode?: number
		onFfmpeg?: (args: Array<string>) => void
		fetchImpl?: typeof fetch
	} = {},
) {
	const ffmpegCalls: Array<Array<string>> = []
	return {
		ffmpegCalls,
		adapter: createAudiobookAdapter({
			config: createTestHomeConnectorConfig({
				audiobookLibraryPath: libraryPath,
				ffmpegPath: 'ffmpeg',
				audiobookImportTimeoutMs: 5_000,
			}),
			probeFfmpeg: async () => true,
			fetchImpl: options.fetchImpl,
			runFfmpeg: async ({ args }) => {
				ffmpegCalls.push(args)
				options.onFfmpeg?.(args)
				if (options.writeOutput !== false && args.at(-1)) {
					await writeFile(args.at(-1)!, 'fake-m4b-bytes')
				}
				return {
					stdout: '',
					stderr: options.ffmpegExitCode === 0 ? '' : 'ffmpeg boom',
					exitCode: options.ffmpegExitCode ?? 0,
					signal: null,
					timedOut: false,
				}
			},
		}),
	}
}

test('sanitizeAudiobookFilename rejects traversal and subdirectories', () => {
	expect(sanitizeAudiobookFilename('Project Hail Mary')).toBe(
		'Project Hail Mary.m4b',
	)
	expect(sanitizeAudiobookFilename('Title.m4b')).toBe('Title.m4b')
	expect(sanitizeAudiobookFilename('Hello... World.m4b')).toBe(
		'Hello... World.m4b',
	)
	expect(() => sanitizeAudiobookFilename('../etc/passwd')).toThrowError(
		AudiobookError,
	)
	expect(() => sanitizeAudiobookFilename('..\\secret.m4b')).toThrowError(
		AudiobookError,
	)
	expect(() => sanitizeAudiobookFilename('/etc/passwd.m4b')).toThrowError(
		AudiobookError,
	)
	expect(() => sanitizeAudiobookFilename('series/Title.m4b')).toThrowError(
		AudiobookError,
	)
	expect(() => sanitizeAudiobookFilename('foo/../Title.m4b')).toThrowError(
		AudiobookError,
	)
	expect(() => sanitizeAudiobookFilename('.hidden.m4b')).toThrowError(
		AudiobookError,
	)
	expect(() => sanitizeAudiobookFilename('')).toThrowError(AudiobookError)
})

test('buildLibraryFilename matches the existing flat Title.m4b library', () => {
	expect(buildLibraryFilename('Blightfall')).toBe('Blightfall.m4b')
	expect(buildLibraryFilename('A Gentleman in Moscow A Novel')).toBe(
		'A Gentleman in Moscow A Novel.m4b',
	)
	expect(buildLibraryFilename('All These Worlds - Bobiverse, Book 3')).toBe(
		'All These Worlds - Bobiverse, Book 3.m4b',
	)
	expect(buildLibraryFilename('Title: Forbidden')).toBe('Title Forbidden.m4b')
	expect(() => buildLibraryFilename('../escape')).toThrowError(AudiobookError)
})

test('resolvePathInsideLibrary refuses paths that escape the library root', () => {
	const libraryRoot = '/media/audiobooks'
	expect(resolveSafeLibraryFile(libraryRoot, 'Title.m4b')).toEqual({
		libraryRoot: path.resolve(libraryRoot),
		filename: 'Title.m4b',
		path: path.resolve(libraryRoot, 'Title.m4b'),
	})
	expect(() =>
		resolvePathInsideLibrary(libraryRoot, '../outside.m4b'),
	).toThrowError(/escapes the audiobook library root/)
})

test('parseAudiobookCredentials reads voucher, key+iv, and activation bytes', () => {
	expect(
		parseAudiobookCredentials({
			voucher: {
				content_license: {
					license_response: { key: sampleKey.toUpperCase(), iv: sampleIv },
				},
			},
		}),
	).toEqual({ kind: 'aaxc', key: sampleKey, iv: sampleIv })
	expect(
		parseAudiobookCredentials({
			voucher: JSON.stringify({ key: sampleKey, iv: sampleIv }),
		}),
	).toEqual({ kind: 'aaxc', key: sampleKey, iv: sampleIv })
	expect(parseAudiobookCredentials({ key: sampleKey, iv: sampleIv })).toEqual({
		kind: 'aaxc',
		key: sampleKey,
		iv: sampleIv,
	})
	expect(parseAudiobookCredentials({ activationBytes: 'DEADBEEF' })).toEqual({
		kind: 'aax',
		activationBytes: 'deadbeef',
	})
	expect(() => parseAudiobookCredentials({})).toThrowError(/voucher/)
	expect(() =>
		parseAudiobookCredentials({ key: 'not-hex', iv: sampleIv }),
	).toThrowError(/hex/)
})

test('buildFfmpegConvertArgs uses audible_key/iv or activation_bytes', () => {
	expect(
		buildFfmpegConvertArgs({
			credentials: { kind: 'aaxc', key: sampleKey, iv: sampleIv },
			sourcePath: '/tmp/book.aaxc',
			outputPath: '/tmp/book.m4b',
		}),
	).toEqual([
		'-hide_banner',
		'-y',
		'-audible_key',
		sampleKey,
		'-audible_iv',
		sampleIv,
		'-f',
		'aax',
		'-i',
		'/tmp/book.aaxc',
		'-c',
		'copy',
		'-f',
		'ipod',
		'/tmp/book.m4b',
	])
	expect(
		buildFfmpegConvertArgs({
			credentials: { kind: 'aax', activationBytes: 'deadbeef' },
			sourcePath: '/tmp/book.aax',
			outputPath: '/tmp/book.m4b',
		}),
	).toContain('-activation_bytes')
	expect(
		buildFfmpegConvertArgs({
			credentials: { kind: 'aaxc', key: sampleKey, iv: sampleIv },
			sourcePath: '/tmp/book.aaxc',
			outputPath: '/tmp/book.m4b',
			title: 'Blightfall',
		}),
	).toEqual([
		'-hide_banner',
		'-y',
		'-audible_key',
		sampleKey,
		'-audible_iv',
		sampleIv,
		'-f',
		'aax',
		'-i',
		'/tmp/book.aaxc',
		'-metadata',
		'title=Blightfall',
		'-c',
		'copy',
		'-f',
		'ipod',
		'/tmp/book.m4b',
	])
	expect(
		buildFfmpegConvertArgs({
			credentials: { kind: 'aaxc', key: sampleKey, iv: sampleIv },
			sourcePath: '/tmp/book.aaxc',
			outputPath: '/tmp/book.m4b',
			metadataPath: '/tmp/book.ffmetadata',
			coverPath: '/tmp/cover.jpg',
			title: 'Blightfall',
		}),
	).toEqual(
		expect.arrayContaining([
			'-map',
			'0:a?',
			'-map',
			'2',
			'-disposition:v:0',
			'attached_pic',
			'-map_chapters',
			'1',
			'-metadata',
			'title=Blightfall',
		]),
	)
	const chaptersOnly = buildFfmpegConvertArgs({
		credentials: { kind: 'aaxc', key: sampleKey, iv: sampleIv },
		sourcePath: '/tmp/book.aaxc',
		outputPath: '/tmp/book.m4b',
		metadataPath: '/tmp/book.ffmetadata',
		title: 'Blightfall',
	})
	expect(chaptersOnly).toEqual(
		expect.arrayContaining([
			'-map_chapters',
			'1',
			'-metadata',
			'title=Blightfall',
		]),
	)
	expect(chaptersOnly).not.toContain('-map')
	expect(chaptersOnly).not.toContain('-map_metadata')
	expect(
		buildFfmetadata({
			title: 'Blightfall',
			chapters: [
				{ title: 'Opening', startMs: 0, lengthMs: 1000 },
				{ title: 'Chapter 1', start_offset_ms: 1000, endMs: 5000 },
			],
		}),
	).toContain('START=0')
})

test('import writes a flat Title.m4b and reports library status', async () => {
	await withLibrary(async (libraryPath) => {
		const sourcePath = path.join(libraryPath, 'source.aaxc')
		await writeFile(sourcePath, 'fake-aaxc')
		const { adapter, ffmpegCalls } = createAdapter(libraryPath)

		const status = await adapter.getLibraryStatus()
		expect(status).toMatchObject({
			libraryPath,
			exists: true,
			writable: true,
			ffmpegAvailable: true,
			hostPaths: {
				synology: '/volume1/media/audio/audiobooks',
				mac: '/Volumes/media/audio/audiobooks',
			},
		})

		const imported = await adapter.importAaxc({
			aaxcPath: sourcePath,
			key: sampleKey,
			iv: sampleIv,
			title: 'Project Hail Mary',
		})
		expect(imported.filename).toBe('Project Hail Mary.m4b')
		expect(imported.path).toBe(path.join(libraryPath, 'Project Hail Mary.m4b'))
		expect(imported.overwritten).toBe(false)
		expect(imported.source).toBe('path')
		expect(await readFile(imported.path, 'utf8')).toBe('fake-m4b-bytes')
		expect(ffmpegCalls[0]).toEqual(
			expect.arrayContaining([
				'-audible_key',
				sampleKey,
				'-audible_iv',
				sampleIv,
				'-metadata',
				'title=Project Hail Mary',
			]),
		)
		expect(ffmpegCalls[0]).not.toContain('-map')
		expect(ffmpegCalls[0]).not.toContain('-map_metadata')
		expect(ffmpegCalls[0]).toEqual(
			expect.arrayContaining(['-f', 'aax', '-c', 'copy', '-f', 'ipod']),
		)
		expect(ffmpegCalls[0]?.at(-1)).toMatch(/\.partial\.m4b$/)

		const exists = await adapter.exists('Project Hail Mary.m4b')
		expect(exists).toEqual({
			filename: 'Project Hail Mary.m4b',
			path: imported.path,
			exists: true,
		})
	})
})

test('import refuses overwrite unless requested and rejects traversal filenames', async () => {
	await withLibrary(async (libraryPath) => {
		const sourcePath = path.join(libraryPath, 'source.aaxc')
		await writeFile(sourcePath, 'fake-aaxc')
		await writeFile(path.join(libraryPath, 'Title.m4b'), 'existing')
		const { adapter, ffmpegCalls } = createAdapter(libraryPath)

		await expect(
			adapter.importAaxc({
				aaxcPath: sourcePath,
				key: sampleKey,
				iv: sampleIv,
				outputFilename: 'Title.m4b',
			}),
		).rejects.toMatchObject({
			code: 'audiobook_already_exists',
		})
		expect(ffmpegCalls).toHaveLength(0)

		await expect(
			adapter.importAaxc({
				aaxcPath: sourcePath,
				key: sampleKey,
				iv: sampleIv,
				outputFilename: '../escape.m4b',
			}),
		).rejects.toMatchObject({
			code: 'audiobook_path_invalid',
		})
		expect(ffmpegCalls).toHaveLength(0)

		await expect(adapter.exists('../escape.m4b')).rejects.toMatchObject({
			code: 'audiobook_path_invalid',
		})
	})
})

test('import accepts aaxcBase64 bytes and optional chapters/cover', async () => {
	await withLibrary(async (libraryPath) => {
		const { adapter, ffmpegCalls } = createAdapter(libraryPath)
		const imported = await adapter.importAaxc({
			aaxcBase64: Buffer.from('fake-aaxc').toString('base64'),
			key: sampleKey,
			iv: sampleIv,
			title: 'Blightfall',
			chapters: [{ title: 'Opening', startMs: 0, lengthMs: 1500 }],
			coverBase64: Buffer.from('fake-cover').toString('base64'),
		})
		expect(imported).toMatchObject({
			filename: 'Blightfall.m4b',
			source: 'bytes',
			chapters: 1,
			coverAttached: true,
		})
		expect(ffmpegCalls[0]).toEqual(
			expect.arrayContaining([
				'-map_chapters',
				'1',
				'-disposition:v:0',
				'-metadata',
				'title=Blightfall',
			]),
		)
		expect(ffmpegCalls[0]).not.toContain('-map_metadata')
		expect(ffmpegCalls[0]?.[ffmpegCalls[0].indexOf('-i') + 1]).toMatch(
			/\.partial\.aaxc$/,
		)
		expect(ffmpegCalls[0]?.at(-1)).toMatch(/\.partial\.m4b$/)
	})
})

test('import downloads aaxcUrl then converts with voucher JSON', async () => {
	await withLibrary(async (libraryPath) => {
		const { adapter } = createAdapter(libraryPath, {
			fetchImpl: async () => new Response('downloaded-aaxc', { status: 200 }),
		})
		const imported = await adapter.importAaxc({
			aaxcUrl: 'https://example.test/owned.aaxc',
			voucher: {
				content_license: {
					license_response: { key: sampleKey, iv: sampleIv },
				},
			},
			outputFilename: 'Owned Title.m4b',
		})
		expect(imported.source).toBe('url')
		expect(imported.filename).toBe('Owned Title.m4b')
		expect(
			await pathExistsSafe(
				path.join(libraryPath, 'Owned Title.m4b.partial.aaxc'),
			),
		).toBe(false)
	})
})

test('import surfaces ffmpeg failures without leaving a partial file', async () => {
	await withLibrary(async (libraryPath) => {
		const sourcePath = path.join(libraryPath, 'source.aaxc')
		await writeFile(sourcePath, 'fake-aaxc')
		const { adapter } = createAdapter(libraryPath, {
			ffmpegExitCode: 1,
			writeOutput: false,
		})
		await expect(
			adapter.importAaxc({
				aaxcPath: sourcePath,
				activationBytes: 'aabbccdd',
				outputFilename: 'Broken.m4b',
			}),
		).rejects.toMatchObject({
			code: 'audiobook_ffmpeg_failed',
		})
		expect(await pathExistsSafe(path.join(libraryPath, 'Broken.m4b'))).toBe(
			false,
		)
		expect(
			await pathExistsSafe(path.join(libraryPath, 'Broken.m4b.partial.m4b')),
		).toBe(false)
	})
})

async function pathExistsSafe(target: string) {
	try {
		await readFile(target)
		return true
	} catch {
		return false
	}
}
