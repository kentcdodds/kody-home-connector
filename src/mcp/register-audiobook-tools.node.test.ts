import { expect, test } from 'vitest'
import {
	AudiobookError,
	type createAudiobookAdapter,
} from '../adapters/audiobook/index.ts'
import { registerAudiobookHomeConnectorTools } from './register-audiobook-tools.ts'

function registerAll(audiobook: ReturnType<typeof createAudiobookAdapter>) {
	const tools = new Map<
		string,
		{
			description: string
			inputSchema: Record<string, unknown>
			handler: (args: Record<string, unknown>) => Promise<{
				isError?: boolean
				structuredContent?: unknown
			}>
		}
	>()
	registerAudiobookHomeConnectorTools({
		audiobook,
		registerTool(descriptor, handler) {
			tools.set(descriptor.name, {
				description: descriptor.description,
				inputSchema: descriptor.inputSchema,
				handler,
			})
		},
	})
	return tools
}

test('registers library path, exists, and import tools', async () => {
	const audiobook = {
		async getLibraryStatus() {
			return {
				libraryPath: '/media/audiobooks',
				hostPaths: {
					synology: '/volume1/media/audio/audiobooks',
					mac: '/Volumes/media/audio/audiobooks',
				},
				exists: true,
				writable: true,
				ffmpegAvailable: true,
				ffmpegPath: 'ffmpeg',
			}
		},
		async exists(filename: string) {
			return {
				filename,
				path: `/media/audiobooks/${filename}`,
				exists: filename === 'Title.m4b',
			}
		},
		async importAaxc() {
			return {
				filename: 'Title.m4b',
				path: '/media/audiobooks/Title.m4b',
				bytes: 12,
				overwritten: false,
				source: 'path' as const,
			}
		},
	} satisfies ReturnType<typeof createAudiobookAdapter>

	const tools = registerAll(audiobook)
	expect(tools.get('audiobook_library_path')).toBeDefined()
	expect(tools.get('audiobook_exists')).toBeDefined()
	expect(tools.get('audiobook_import_aaxc')).toBeDefined()
	expect(tools.get('audiobook_import_aaxc')?.inputSchema).toMatchObject({
		properties: {
			key: { 'x-kody-secret': true },
			iv: { 'x-kody-secret': true },
			voucher: { 'x-kody-secret': true },
			activationBytes: { 'x-kody-secret': true },
		},
	})

	const library = await tools.get('audiobook_library_path')!.handler({
		filename: 'Title.m4b',
	})
	expect(library.structuredContent).toMatchObject({
		ok: true,
		libraryPath: '/media/audiobooks',
		file: { exists: true, filename: 'Title.m4b' },
	})

	const missing = await tools.get('audiobook_exists')!.handler({
		filename: 'Missing.m4b',
	})
	expect(missing.structuredContent).toMatchObject({
		ok: true,
		exists: false,
		filename: 'Missing.m4b',
	})

	const imported = await tools.get('audiobook_import_aaxc')!.handler({
		aaxcPath: '/tmp/book.aaxc',
		key: '00',
		iv: '11',
		outputFilename: 'Title.m4b',
	})
	expect(imported.structuredContent).toMatchObject({
		ok: true,
		filename: 'Title.m4b',
		bytes: 12,
	})
})

test('maps adapter path errors to structured MCP errors', async () => {
	const audiobook = {
		async getLibraryStatus() {
			return {
				libraryPath: '/media/audiobooks',
				hostPaths: {
					synology: '/volume1/media/audio/audiobooks',
					mac: '/Volumes/media/audio/audiobooks',
				},
				exists: true,
				writable: true,
				ffmpegAvailable: true,
				ffmpegPath: 'ffmpeg',
			}
		},
		async exists() {
			throw new AudiobookError({
				code: 'audiobook_path_invalid',
				message:
					'outputFilename must be a flat file in the audiobook library root. Subdirectories and ".." are rejected.',
				filename: '../escape.m4b',
			})
		},
		async importAaxc() {
			throw new Error('should not import')
		},
	} satisfies ReturnType<typeof createAudiobookAdapter>

	const tools = registerAll(audiobook)
	const result = await tools.get('audiobook_exists')!.handler({
		filename: '../escape.m4b',
	})
	expect(result.isError).toBe(true)
	expect(result.structuredContent).toMatchObject({
		ok: false,
		error: {
			code: 'audiobook_path_invalid',
			filename: '../escape.m4b',
		},
	})
})
