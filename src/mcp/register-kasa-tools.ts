import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
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

function getSelector(args: Record<string, unknown>) {
	return {
		plugId: args['plugId'] == null ? undefined : String(args['plugId']),
		alias: args['alias'] == null ? undefined : String(args['alias']),
	}
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
				'Discover TP-Link Kasa KLAP/SHIP 2.0 smart plugs on the configured local CIDRs, persist them locally, and return discovery diagnostics.',
			inputSchema: {},
		},
		async () => {
			const plugs = await kasa.scan()
			return structuredTextResult(
				plugs.length === 0
					? 'No Kasa smart plugs were discovered.'
					: `Discovered ${plugs.length} Kasa smart plug(s).`,
				{
					plugs,
					diagnostics: kasa.getDiscoveryDiagnostics(),
				},
			)
		},
	)

	registerTool(
		{
			name: 'kasa_list_plugs',
			title: 'List Kasa Smart Plugs',
			description:
				'List locally known Kasa smart plugs with alias, adoption state, cached relay state, host, and credential readiness.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = kasa.getStatus()
			return structuredTextResult(
				status.plugs.length === 0
					? 'No Kasa smart plugs are currently known.'
					: status.plugs
							.map(
								(plug) =>
									`- ${plug.alias} (${plug.plugId}) adopted=${String(plug.adopted)} relay=${plug.relayState}`,
							)
							.join('\n'),
				status,
			)
		},
	)

	const selectorSchema = buildToolInputSchema(
		z
			.object({
				plugId: z.string().min(1).optional(),
				alias: z.string().min(1).optional(),
			})
			.refine(
				(value) =>
					Number(Boolean(value.plugId)) + Number(Boolean(value.alias)) === 1,
				{
					message: 'Provide exactly one of plugId or alias.',
				},
			),
	)

	registerTool(
		{
			name: 'kasa_adopt_plug',
			title: 'Adopt Kasa Smart Plug',
			description:
				'Mark a discovered Kasa smart plug as adopted so it can be controlled by Kody.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
		},
		async (args) => {
			const plug = kasa.adoptPlug(getSelector(args))
			return structuredTextResult(`Adopted Kasa smart plug ${plug.alias}.`, {
				plug,
			})
		},
	)

	registerTool(
		{
			name: 'kasa_forget_plug',
			title: 'Forget Kasa Smart Plug',
			description:
				'Remove a Kasa smart plug from local connector storage. Credentials remain stored for future scans.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
		},
		async (args) => {
			const plug = kasa.forgetPlug(getSelector(args))
			return structuredTextResult(`Forgot Kasa smart plug ${plug.alias}.`, {
				plug,
			})
		},
	)

	const credentialsSchema = buildToolInputSchema({
		username: z
			.string()
			.min(1)
			.describe('TP-Link/Kasa app account email address.'),
		password: z.string().min(1).describe('TP-Link/Kasa app account password.'),
	})

	registerTool(
		{
			name: 'kasa_set_credentials',
			title: 'Set Kasa Credentials',
			description:
				'Store TP-Link/Kasa account username and password locally in the connector so Kasa KLAP plugs can authenticate.',
			inputSchema: markSecretInputFields(credentialsSchema.inputSchema, [
				'username',
				'password',
			]) as Record<string, unknown>,
			sdkInputSchema: credentialsSchema.sdkInputSchema,
		},
		async (args) => {
			const status = kasa.setCredentials(
				String(args['username'] ?? ''),
				String(args['password'] ?? ''),
			)
			return structuredTextResult('Stored Kasa credentials locally.', {
				status,
			})
		},
	)

	registerTool(
		{
			name: 'kasa_get_plug_status',
			title: 'Get Kasa Smart Plug Status',
			description:
				'Read live KLAP status for a known Kasa smart plug by stable plugId or exact unique alias.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const result = await kasa.getPlugStatus(getSelector(args))
			return structuredTextResult(
				`Kasa smart plug ${result.plug.alias} is ${result.relayState}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'kasa_turn_plug_on',
			title: 'Turn Kasa Smart Plug On',
			description:
				'Turn on an adopted Kasa smart plug by stable plugId or exact unique alias. Arbitrary IP control is not accepted.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
		},
		async (args) => {
			const result = await kasa.turnOn(getSelector(args))
			return structuredTextResult(
				`Turned Kasa smart plug ${result.plug.alias} on.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'kasa_turn_plug_off',
			title: 'Turn Kasa Smart Plug Off',
			description:
				'Turn off an adopted Kasa smart plug by stable plugId or exact unique alias. Arbitrary IP control is not accepted.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await kasa.turnOff(getSelector(args))
			return structuredTextResult(
				`Turned Kasa smart plug ${result.plug.alias} off.`,
				result,
			)
		},
	)
}
