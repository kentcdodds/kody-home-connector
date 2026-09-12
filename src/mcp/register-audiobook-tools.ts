import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
import { z } from 'zod'
import {
	isAudiobookError,
	type createAudiobookAdapter,
} from '../adapters/audiobook/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type AudiobookToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type AudiobookRegisteredToolDescriptor = AudiobookToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type AudiobookToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

function structuredTextResult(
	text: string,
	structuredContent: unknown,
): CallToolResult {
	return {
		content: [
			{
				type: 'text',
				text,
			},
		],
		structuredContent,
	}
}

function audiobookErrorResult(error: unknown): CallToolResult | null {
	if (!isAudiobookError(error)) return null
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: error.message,
			},
		],
		structuredContent: {
			ok: false,
			error: {
				code: error.code,
				message: error.message,
				path: error.path ?? null,
				filename: error.filename ?? null,
			},
		},
	}
}

async function handleExpectedAudiobookError(
	handler: () => Promise<CallToolResult> | CallToolResult,
) {
	try {
		return await handler()
	} catch (error) {
		const result = audiobookErrorResult(error)
		if (result) return result
		throw error
	}
}

const chapterSchema = z.object({
	title: z.string().min(1),
	startMs: z.number().int().min(0).optional(),
	start_offset_ms: z.number().int().min(0).optional(),
	endMs: z.number().int().min(0).optional(),
	lengthMs: z.number().int().min(0).optional(),
	length_ms: z.number().int().min(0).optional(),
})

const importSchema = buildToolInputSchema(
	z
		.object({
			aaxcPath: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Temp AAXC/AAX path on the connector host. Provide exactly one source: aaxcPath, aaxcBase64, or aaxcUrl.',
				),
			aaxcBase64: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Base64-encoded AAXC bytes. Full-length titles usually exceed MCP payload limits — prefer aaxcPath or aaxcUrl.',
				),
			aaxcUrl: z
				.string()
				.min(1)
				.optional()
				.describe(
					'http(s) URL for already-downloaded AAXC bytes. @kody/audible owns Audible download; home only fetches and converts.',
				),
			voucher: z
				.union([z.string().min(1), z.record(z.string(), z.unknown())])
				.optional()
				.describe(
					'Audible voucher JSON (string or object) with license_response.key and .iv.',
				),
			voucherPath: z
				.string()
				.min(1)
				.optional()
				.describe('Local voucher JSON file path on the connector host.'),
			key: z
				.string()
				.min(1)
				.optional()
				.describe('AAXC audible_key hex from the voucher. Preferred with iv.'),
			iv: z
				.string()
				.min(1)
				.optional()
				.describe('AAXC audible_iv hex from the voucher. Preferred with key.'),
			activationBytes: z
				.string()
				.min(1)
				.optional()
				.describe('AAX activation_bytes hex. Not used for AAXC.'),
			title: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Book title. Home turns this into the existing library name: flat "Title.m4b" (no Author prefix). Prefer this over outputFilename.',
				),
			outputFilename: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Override flat Title.m4b filename. Subdirectories and ".." are rejected.',
				),
			chapters: z
				.array(chapterSchema)
				.optional()
				.describe(
					'Optional chapter list. startMs (or start_offset_ms) plus endMs or lengthMs/length_ms.',
				),
			coverBase64: z
				.string()
				.min(1)
				.optional()
				.describe('Optional cover image as base64 (jpeg/png, under 10MB).'),
			coverPath: z
				.string()
				.min(1)
				.optional()
				.describe('Optional local cover image path on the connector host.'),
			overwrite: z
				.boolean()
				.optional()
				.describe('Replace an existing Title.m4b. Defaults to false.'),
		})
		.refine(
			(value) =>
				Number(Boolean(value.aaxcPath)) +
					Number(Boolean(value.aaxcUrl)) +
					Number(Boolean(value.aaxcBase64)) ===
				1,
			{
				message: 'Provide exactly one of aaxcPath, aaxcBase64, or aaxcUrl.',
			},
		)
		.refine(
			(value) =>
				Boolean(value.voucher) ||
				Boolean(value.voucherPath) ||
				(Boolean(value.key) && Boolean(value.iv)) ||
				Boolean(value.activationBytes),
			{
				message: 'Provide voucher or voucherPath, key+iv, or activationBytes.',
			},
		)
		.refine((value) => Boolean(value.title) || Boolean(value.outputFilename), {
			message: 'Provide title (preferred) or outputFilename.',
		}),
)

export function registerAudiobookHomeConnectorTools(input: {
	registerTool: (
		descriptor: AudiobookRegisteredToolDescriptor,
		handler: AudiobookToolHandler,
	) => void
	audiobook: ReturnType<typeof createAudiobookAdapter>
}) {
	const { registerTool, audiobook } = input

	registerTool(
		{
			name: 'audiobook_library_path',
			title: 'Get Audiobook Library Path',
			description:
				'Read the personal audiobook archive path mounted into this home connector (default /media/audiobooks, matching mediarss). Returns whether the directory exists and is writable, plus ffmpeg readiness. Optional filename checks whether that flat Title.m4b already exists. Library naming is title-only (Blightfall.m4b), not Author - Title. This is convert+disk write only; Audible API/auth lives in @kody/audible.',
			...buildToolInputSchema({
				filename: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Optional flat Title.m4b name to check for an existing archive file.',
					),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			return await handleExpectedAudiobookError(async () => {
				const status = await audiobook.getLibraryStatus()
				const filename =
					args['filename'] == null ? undefined : String(args['filename'])
				const existing = filename ? await audiobook.exists(filename) : undefined
				return structuredTextResult(
					status.exists
						? `Audiobook library ${status.libraryPath} is ${status.writable ? 'writable' : 'not writable'}.`
						: `Audiobook library ${status.libraryPath} is not mounted.`,
					{
						ok: true,
						...status,
						file: existing ?? null,
					},
				)
			})
		},
	)

	registerTool(
		{
			name: 'audiobook_exists',
			title: 'Check Audiobook Archive File',
			description:
				'Check whether a flat Title.m4b already exists in the personal audiobook library. Rejects path traversal and subdirectories.',
			...buildToolInputSchema({
				filename: z
					.string()
					.min(1)
					.describe('Flat Title.m4b filename relative to the library root.'),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			return await handleExpectedAudiobookError(async () => {
				const result = await audiobook.exists(String(args['filename'] ?? ''))
				return structuredTextResult(
					result.exists
						? `${result.filename} is already in the audiobook library.`
						: `${result.filename} is not in the audiobook library.`,
					{
						ok: true,
						...result,
					},
				)
			})
		},
	)

	registerTool(
		{
			name: 'audiobook_library_filename',
			title: 'Build Audiobook Library Filename',
			description:
				'Turn a book title into the existing library filename: flat Title.m4b in the audiobooks root (no Author prefix). Use this before audiobook_exists / audiobook_import_aaxc.',
			...buildToolInputSchema({
				title: z
					.string()
					.min(1)
					.describe('Book title, as it should appear on disk.'),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			return await handleExpectedAudiobookError(async () => {
				const result = audiobook.libraryFilename(String(args['title'] ?? ''))
				return structuredTextResult(
					`Library filename for that title is ${result.filename}.`,
					{
						ok: true,
						...result,
					},
				)
			})
		},
	)

	registerTool(
		{
			name: 'audiobook_import_aaxc',
			title: 'Import AAXC/AAX To M4B',
			description:
				'Convert an owned Audible AAXC (bytes or temp path + voucher key/iv) to a flat Title.m4b matching the existing library (title only). Optional chapters and cover. Home does ffmpeg convert and disk write only. @kody/audible downloads, then calls this tool.',
			inputSchema: markSecretInputFields(importSchema.inputSchema, [
				'voucher',
				'aaxcBase64',
				'key',
				'iv',
				'activationBytes',
				'coverBase64',
			]) as Record<string, unknown>,
			sdkInputSchema: importSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			return await handleExpectedAudiobookError(async () => {
				const result = await audiobook.importAaxc({
					aaxcPath:
						args['aaxcPath'] == null ? undefined : String(args['aaxcPath']),
					aaxcUrl:
						args['aaxcUrl'] == null ? undefined : String(args['aaxcUrl']),
					aaxcBase64:
						args['aaxcBase64'] == null ? undefined : String(args['aaxcBase64']),
					voucher: args['voucher'],
					voucherPath:
						args['voucherPath'] == null
							? undefined
							: String(args['voucherPath']),
					key: args['key'] == null ? undefined : String(args['key']),
					iv: args['iv'] == null ? undefined : String(args['iv']),
					activationBytes:
						args['activationBytes'] == null
							? undefined
							: String(args['activationBytes']),
					title: args['title'] == null ? undefined : String(args['title']),
					outputFilename:
						args['outputFilename'] == null
							? undefined
							: String(args['outputFilename']),
					chapters: Array.isArray(args['chapters'])
						? (args['chapters'] as Array<{
								title: string
								startMs?: number
								start_offset_ms?: number
								endMs?: number
								lengthMs?: number
								length_ms?: number
							}>)
						: undefined,
					coverBase64:
						args['coverBase64'] == null
							? undefined
							: String(args['coverBase64']),
					coverPath:
						args['coverPath'] == null ? undefined : String(args['coverPath']),
					overwrite:
						args['overwrite'] == null ? undefined : Boolean(args['overwrite']),
				})
				return structuredTextResult(
					`Imported ${result.filename} (${result.bytes} bytes) into the audiobook library.`,
					{
						ok: true,
						...result,
					},
				)
			})
		},
	)
}
