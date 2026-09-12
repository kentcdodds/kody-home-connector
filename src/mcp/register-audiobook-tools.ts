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

const importSchema = buildToolInputSchema(
	z
		.object({
			aaxcPath: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Local AAXC/AAX path already on the connector host. Provide exactly one of aaxcPath or aaxcUrl.',
				),
			aaxcUrl: z
				.string()
				.min(1)
				.optional()
				.describe(
					'http(s) URL for an already-downloaded AAXC/AAX. The @kody/audible package owns Audible download; home only fetches and converts.',
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
				.describe('AAXC audible_key hex, if not providing a voucher.'),
			iv: z
				.string()
				.min(1)
				.optional()
				.describe('AAXC audible_iv hex, if not providing a voucher.'),
			activationBytes: z
				.string()
				.min(1)
				.optional()
				.describe('AAX activation_bytes hex. Not used for AAXC.'),
			outputFilename: z
				.string()
				.min(1)
				.describe(
					'Flat Title.m4b filename written into the audiobook library root. Subdirectories and ".." are rejected.',
				),
			overwrite: z
				.boolean()
				.optional()
				.describe('Replace an existing Title.m4b. Defaults to false.'),
		})
		.refine(
			(value) =>
				Number(Boolean(value.aaxcPath)) + Number(Boolean(value.aaxcUrl)) === 1,
			{
				message: 'Provide exactly one of aaxcPath or aaxcUrl.',
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
		),
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
				'Read the personal audiobook archive path mounted into this home connector (default /media/audiobooks, matching mediarss). Returns whether the directory exists and is writable, plus ffmpeg readiness. Optional filename checks whether that flat Title.m4b already exists. This is convert+disk write only; Audible API/auth lives in @kody/audible.',
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
			name: 'audiobook_import_aaxc',
			title: 'Import AAXC/AAX To M4B',
			description:
				'Convert an owned Audible AAXC (voucher or key+iv) or AAX (activation_bytes) to a flat Title.m4b in the personal audiobook library. Home-connector does ffmpeg convert and disk write only. The @kody/audible package must already have downloaded the AAXC and extracted the voucher or key+iv. Output stays in the library root; path traversal is rejected.',
			inputSchema: markSecretInputFields(importSchema.inputSchema, [
				'voucher',
				'key',
				'iv',
				'activationBytes',
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
					outputFilename: String(args['outputFilename'] ?? ''),
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
