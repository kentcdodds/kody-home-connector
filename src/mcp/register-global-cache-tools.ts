import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createGlobalCacheAdapter } from '../adapters/global-cache/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type GlobalCacheToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type GlobalCacheRegisteredToolDescriptor = GlobalCacheToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type GlobalCacheToolHandler = (
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

export function registerGlobalCacheHomeConnectorTools(input: {
	registerTool: (
		descriptor: GlobalCacheRegisteredToolDescriptor,
		handler: GlobalCacheToolHandler,
	) => void
	globalCache: ReturnType<typeof createGlobalCacheAdapter>
}) {
	const { registerTool, globalCache } = input

	registerTool(
		{
			name: 'globalcache_get_status',
			title: 'Global Cache Status',
			description:
				'Show the court iTach IP2IR host, IR port map (HDMI switch, projector, Rotosphere blaster), and whether mock IR is enabled.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = globalCache.getStatus()
			return structuredTextResult(
				`iTach ${status.host}:${String(status.port)} commands=${String(status.commandCount)} mocks=${String(status.mocksEnabled)}`,
				status,
			)
		},
	)

	registerTool(
		{
			name: 'globalcache_list_ir_commands',
			title: 'List Global Cache IR Commands',
			description:
				'List named court IR commands with reliability (proven, guessed, or unreliable Flipper conversions). Prefer proven HDMI 1/2 and projector on/standby/HDMI. Rotosphere Auto and most color buttons still need a real iTach learn.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const commands = globalCache.listIrCommands()
			return structuredTextResult(
				commands
					.map(
						(command) =>
							`- ${command.commandId} (${command.reliability}) ${command.title}`,
					)
					.join('\n'),
				{ commands },
			)
		},
	)

	registerTool(
		{
			name: 'globalcache_send_ir',
			title: 'Send Global Cache IR',
			description:
				'Send one named court IR command through the iTach. Rotosphere commands set jack 3 to IR_BLASTER first. Unknown command ids fail closed.',
			...buildToolInputSchema({
				commandId: z.string().min(1),
			}),
		},
		async (args) => {
			const commandId = String(args['commandId'] ?? '')
			const result = await globalCache.sendIr(commandId)
			return structuredTextResult(
				`Sent ${result.commandId} on ${result.connector}: ${result.response}`,
				result,
			)
		},
	)
}
