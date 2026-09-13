import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
import { z } from 'zod'
import {
	isSonyIrccCommandName,
	sonyIrccCommandNames,
	type createSonyBlurayAdapter,
	type SonyIrccCommandName,
} from '../adapters/sony-bluray/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type BlurayToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type BlurayRegisteredToolDescriptor = BlurayToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type BlurayToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

const offlineCatalogNote =
	'Always registered. When the court Blu-ray is unplugged, in network standby off, or unconfigured, returns `{ connected: false, reason }` instead of throwing. 192.168.0.115 is the Sony camera (bisyamon), not the player.'

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

function statusText(status: { connected: boolean; reason: string }) {
	return status.connected
		? status.reason
		: `Court Blu-ray not connected: ${status.reason}`
}

const namedCommands = [
	{ name: 'bluray_play', command: 'play', title: 'Blu-ray Play' },
	{ name: 'bluray_pause', command: 'pause', title: 'Blu-ray Pause' },
	{ name: 'bluray_stop', command: 'stop', title: 'Blu-ray Stop' },
	{ name: 'bluray_eject', command: 'eject', title: 'Blu-ray Eject' },
	{ name: 'bluray_up', command: 'up', title: 'Blu-ray Up' },
	{ name: 'bluray_down', command: 'down', title: 'Blu-ray Down' },
	{ name: 'bluray_left', command: 'left', title: 'Blu-ray Left' },
	{ name: 'bluray_right', command: 'right', title: 'Blu-ray Right' },
	{ name: 'bluray_enter', command: 'enter', title: 'Blu-ray Enter' },
	{ name: 'bluray_home', command: 'home', title: 'Blu-ray Home' },
	{ name: 'bluray_back', command: 'back', title: 'Blu-ray Back' },
	{ name: 'bluray_options', command: 'options', title: 'Blu-ray Options' },
] as const satisfies ReadonlyArray<{
	name: string
	command: SonyIrccCommandName
	title: string
}>

export function registerBlurayHomeConnectorTools(input: {
	registerTool: (
		descriptor: BlurayRegisteredToolDescriptor,
		handler: BlurayToolHandler,
	) => void
	bluray: ReturnType<typeof createSonyBlurayAdapter>
}) {
	const { registerTool, bluray } = input

	registerTool(
		{
			name: 'bluray_status',
			title: 'Court Blu-ray Status',
			description: `Probe the court Sony UHD Blu-ray over LAN IRCC (Ircc.xml / actionList / dmr.xml). ${offlineCatalogNote} HDMI path is switch IN 2.`,
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = await bluray.getStatus()
			return structuredTextResult(statusText(status), status)
		},
	)

	const scanSchema = buildToolInputSchema({
		hosts: z
			.array(z.string().min(1))
			.optional()
			.describe(
				'Optional host/IP candidates to probe. Never include 192.168.0.115 (Sony camera).',
			),
	})

	registerTool(
		{
			name: 'bluray_scan',
			title: 'Scan Court Blu-ray IRCC Hosts',
			description: `Probe explicit hosts plus COURT_BLURAY_SCAN_EXTRA_HOSTS for Sony IRCC. Does not default to 192.168.0.115. ${offlineCatalogNote}`,
			inputSchema: scanSchema.inputSchema,
			sdkInputSchema: scanSchema.sdkInputSchema,
		},
		async (args) => {
			const hosts = Array.isArray(args['hosts'])
				? args['hosts'].map((host) => String(host))
				: undefined
			const result = await bluray.scan({ hosts })
			const found = result.players.length
			return structuredTextResult(
				found === 0
					? 'No Sony IRCC Blu-ray player was found. The court unit is often unplugged.'
					: `Found ${String(found)} Sony IRCC player(s).`,
				result,
			)
		},
	)

	const setHostSchema = buildToolInputSchema({
		host: z.string().min(1),
		macAddress: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		authCookie: z.string().min(1).optional(),
		psk: z.string().min(1).optional(),
	})

	registerTool(
		{
			name: 'bluray_set_host',
			title: 'Set Court Blu-ray Host',
			description:
				'Persist the court Blu-ray IP (and optional MAC / auth cookie / PSK), then probe IRCC. Rejects 192.168.0.115 (Sony camera). Empty/unset host is the normal offline state — use this when the player is powered and its LAN IP is known.',
			inputSchema: markSecretInputFields(setHostSchema.inputSchema, [
				'authCookie',
				'psk',
			]) as Record<string, unknown>,
			sdkInputSchema: setHostSchema.sdkInputSchema,
		},
		async (args) => {
			const status = await bluray.setHost({
				host: String(args['host'] ?? ''),
				macAddress:
					args['macAddress'] == null ? undefined : String(args['macAddress']),
				name: args['name'] == null ? undefined : String(args['name']),
				authCookie:
					args['authCookie'] == null ? undefined : String(args['authCookie']),
				psk: args['psk'] == null ? undefined : String(args['psk']),
			})
			return structuredTextResult(statusText(status), status)
		},
	)

	registerTool(
		{
			name: 'bluray_forget',
			title: 'Forget Court Blu-ray Host',
			description:
				'Clear the persisted court Blu-ray host/MAC/auth. Env COURT_BLURAY_HOST still applies if set. Status becomes not connected / not configured when nothing remains.',
			inputSchema: {},
		},
		async () => {
			const status = await bluray.forget()
			return structuredTextResult(statusText(status), status)
		},
	)

	const pressSchema = buildToolInputSchema({
		command: z.enum(sonyIrccCommandNames),
	})

	registerTool(
		{
			name: 'bluray_press',
			title: 'Press Court Blu-ray IRCC Command',
			description: `Send one mapped Sony IRCC command (play/pause/stop, d-pad, home/back/options, eject, power). powerOff uses the BD1 Power toggle twice; powerOn / power are a single toggle. ${offlineCatalogNote} Patch's court-projector mini remote can call this plus bluray_status.`,
			inputSchema: pressSchema.inputSchema,
			sdkInputSchema: pressSchema.sdkInputSchema,
		},
		async (args) => {
			const command = String(args['command'] ?? '')
			if (!isSonyIrccCommandName(command)) {
				const status = await bluray.getStatus()
				return structuredTextResult(`Unknown Blu-ray command "${command}".`, {
					...status,
					connected: false,
					reason: `Unknown Blu-ray command "${command}".`,
					command,
					irccCode: null,
					irccPresses: 0,
					transport: null,
					wakeOnLan: null,
					httpStatus: null,
				})
			}
			const result = await bluray.press(command)
			return structuredTextResult(statusText(result), result)
		},
	)

	for (const tool of namedCommands) {
		registerTool(
			{
				name: tool.name,
				title: tool.title,
				description: `Send Sony IRCC ${tool.command} to the court Blu-ray. ${offlineCatalogNote}`,
				inputSchema: {},
			},
			async () => {
				const result = await bluray.press(tool.command)
				return structuredTextResult(statusText(result), result)
			},
		)
	}

	registerTool(
		{
			name: 'bluray_power_on',
			title: 'Court Blu-ray Power On',
			description: `Wake-on-LAN (when a MAC is stored) plus one BD1 Power toggle (AAAAAwAAHFoAAAAVAw==). UBP/BDP players have no discrete PowerOn IRCC — Bravia AAAAAQAAAAEAAAAuAw== is ignored. A single press wakes standby; if the deck is already on it may open the power-off confirm UI instead of turning it off. ${offlineCatalogNote} Power-on usually needs the player plugged in with network standby on.`,
			inputSchema: {},
		},
		async () => {
			const result = await bluray.powerOn()
			return structuredTextResult(statusText(result), result)
		},
	)

	registerTool(
		{
			name: 'bluray_power_off',
			title: 'Court Blu-ray Power Off',
			description: `Send the BD1 Power toggle (AAAAAwAAHFoAAAAVAw==) twice with a short gap. UBP-X700 / BDP-CE have no discrete PowerOff — Bravia AAAAAQAAAAEAAAAvAw== returns HTTP 200 but does not turn the player off. The first press opens the confirm dialog; the second confirms, matching the laptop BDP-CE double-power pattern. bluray_press({ command: "power" }) is a single toggle. ${offlineCatalogNote}`,
			inputSchema: {},
			annotations: {
				destructiveHint: true,
			},
		},
		async () => {
			const result = await bluray.powerOff()
			return structuredTextResult(statusText(result), result)
		},
	)
}
