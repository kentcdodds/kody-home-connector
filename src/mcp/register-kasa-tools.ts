import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createKasaAdapter } from '../adapters/kasa/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type KasaToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type KasaRegisteredToolDescriptor = KasaToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type KasaToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

function plugIdentifierSchema() {
	return buildToolInputSchema({
		plug: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Kasa plugId or exact/unique alias. When omitted, exactly one known/adopted plug must be available.',
			),
	})
}

export function registerKasaHomeConnectorTools(input: {
	registerTool: (
		descriptor: KasaRegisteredToolDescriptor,
		handler: KasaToolHandler,
	) => void
	kasa: ReturnType<typeof createKasaAdapter>
}) {
	const { registerTool, kasa } = input

	registerTool(
		{
			name: 'kasa_scan_plugs',
			title: 'Scan Kasa Smart Plugs',
			description:
				'Scan configured private CIDRs for TP-Link Kasa smart plugs using the legacy local TCP/9999 protocol, persist discovered plugs locally, and return discovery diagnostics.',
			inputSchema: {},
		},
		async () => {
			const plugs = await kasa.scan()
			const status = kasa.getStatus()
			return {
				content: [
					{
						type: 'text' as const,
						text:
							plugs.length === 0
								? 'No Kasa plugs were discovered.'
								: `Discovered or updated ${plugs.length} Kasa plug(s).`,
					},
				],
				structuredContent: {
					plugs,
					diagnostics: status.diagnostics,
				},
			}
		},
	)

	registerTool(
		{
			name: 'kasa_list_plugs',
			title: 'List Kasa Smart Plugs',
			description:
				'List Kasa plugs known to the connector, including stable plug IDs, aliases, host metadata, adoption state, and latest cached relay state.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = kasa.getStatus()
			return {
				content: [
					{
						type: 'text' as const,
						text:
							status.plugs.length === 0
								? 'No Kasa plugs are currently known.'
								: status.plugs
										.map(
											(plug) =>
												`- ${plug.alias} (${plug.plugId}) adopted=${String(plug.adopted)} state=${plug.relayState === 1 ? 'on' : plug.relayState === 0 ? 'off' : 'unknown'} host=${plug.host}:${String(plug.port)}`,
										)
										.join('\n'),
					},
				],
				structuredContent: status,
			}
		},
	)

	registerTool(
		{
			name: 'kasa_adopt_plug',
			title: 'Adopt Kasa Smart Plug',
			description:
				'Mark a discovered Kasa plug as adopted so explicit on/off control tools can target it. Control never accepts arbitrary IP addresses.',
			...buildToolInputSchema({
				plugId: z.string().min(1),
			}),
		},
		async (args) => {
			const plug = kasa.adoptPlug(String(args['plugId'] ?? ''))
			return {
				content: [
					{
						type: 'text' as const,
						text: `Adopted Kasa plug ${plug.alias} (${plug.plugId}).`,
					},
				],
				structuredContent: { plug },
			}
		},
	)

	registerTool(
		{
			name: 'kasa_forget_plug',
			title: 'Forget Kasa Smart Plug',
			description:
				'Remove a Kasa plug from this connector database. Re-run kasa_scan_plugs to discover it again.',
			...buildToolInputSchema({
				plugId: z.string().min(1),
			}),
		},
		async (args) => {
			const plug = kasa.forgetPlug(String(args['plugId'] ?? ''))
			return {
				content: [
					{
						type: 'text' as const,
						text: `Forgot Kasa plug ${plug.alias} (${plug.plugId}).`,
					},
				],
				structuredContent: { plug, forgotten: true },
			}
		},
	)

	const statusSchema = plugIdentifierSchema()
	registerTool(
		{
			name: 'kasa_get_plug_status',
			title: 'Get Kasa Smart Plug Status',
			description:
				'Read live relay status and sysinfo from a known Kasa plug by plugId or alias.',
			inputSchema: statusSchema.inputSchema,
			sdkInputSchema: statusSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const result = await kasa.getPlugStatus(
				args['plug'] == null ? undefined : String(args['plug']),
			)
			return {
				content: [
					{
						type: 'text' as const,
						text: `${result.plug.alias} is ${result.plug.relayState === 1 ? 'on' : result.plug.relayState === 0 ? 'off' : 'in an unknown state'}.`,
					},
				],
				structuredContent: result,
			}
		},
	)

	for (const tool of [
		{
			name: 'kasa_turn_plug_on',
			title: 'Turn Kasa Smart Plug On',
			state: 'on' as const,
			handler: kasa.turnPlugOn,
			description:
				'Turn an adopted Kasa smart plug on by plugId or alias using the local legacy protocol. Use only when the target plug identity is clear.',
			annotations: {},
		},
		{
			name: 'kasa_turn_plug_off',
			title: 'Turn Kasa Smart Plug Off',
			state: 'off' as const,
			handler: kasa.turnPlugOff,
			description:
				'Turn an adopted Kasa smart plug off by plugId or alias using the local legacy protocol. Use only when the target plug identity is clear and safe to power down.',
			annotations: {
				destructiveHint: true,
			},
		},
	] as const) {
		const schema = plugIdentifierSchema()
		registerTool(
			{
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: schema.inputSchema,
				sdkInputSchema: schema.sdkInputSchema,
				annotations: tool.annotations,
			},
			async (args) => {
				const result = await tool.handler(
					args['plug'] == null ? undefined : String(args['plug']),
				)
				return {
					content: [
						{
							type: 'text' as const,
							text: result.confirmed
								? `Turned Kasa plug ${result.plug.alias} ${tool.state}.`
								: `Requested Kasa plug ${result.plug.alias} ${tool.state}; the plug accepted the relay command but follow-up status read failed.`,
						},
					],
					structuredContent: result,
				}
			},
		)
	}
}
