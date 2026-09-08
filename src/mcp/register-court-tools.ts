import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	rotosphereActions,
	type createCourtAdapter,
} from '../adapters/court/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type CourtToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type CourtRegisteredToolDescriptor = CourtToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type CourtToolHandler = (
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

export function registerCourtHomeConnectorTools(input: {
	registerTool: (
		descriptor: CourtRegisteredToolDescriptor,
		handler: CourtToolHandler,
	) => void
	court: ReturnType<typeof createCourtAdapter>
}) {
	const { registerTool, court } = input

	registerTool(
		{
			name: 'court_get_status',
			title: 'Court AV Status',
			description:
				'Summarize court AV wiring: iTach port map, HDMI input reliability, court Roku/Sonos ids, and the Rotosphere IR caveat.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = court.getStatus()
			return structuredTextResult(
				`Court Roku ${status.rokuName ?? 'unresolved'}; Rotosphere IR is incomplete.`,
				status,
			)
		},
	)

	registerTool(
		{
			name: 'court_start_roku',
			title: 'Start Court Roku',
			description:
				'Start the sport court on Roku: projector ON, HDMI switch input 1, Sport Court Sonos HDMI/TV input, then Roku Home or a named/id app (YouTube, etc.). Lamp warmup can take 15-30s. Requires an adopted court Roku.',
			...buildToolInputSchema({
				appName: z.string().min(1).optional(),
				appId: z.string().min(1).optional(),
				rokuDeviceId: z.string().min(1).optional(),
				sonosPlayerId: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const result = await court.startRoku({
				appName: args['appName'] == null ? undefined : String(args['appName']),
				appId: args['appId'] == null ? undefined : String(args['appId']),
				rokuDeviceId:
					args['rokuDeviceId'] == null
						? undefined
						: String(args['rokuDeviceId']),
				sonosPlayerId:
					args['sonosPlayerId'] == null
						? undefined
						: String(args['sonosPlayerId']),
			})
			const appLabel = result.appId ? `app ${result.appId}` : 'Home'
			return structuredTextResult(
				`Court Roku started (${appLabel}) on ${result.rokuName}. ${result.notes}`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'court_set_hdmi_input',
			title: 'Set Court HDMI Input',
			description:
				'Select MROCIOA HDMI switch input 1-5 via iTach IR1. 1 is Roku (proven), 2 is Blu-ray (proven), 3-5 are sequential guesses.',
			...buildToolInputSchema({
				input: z.union([
					z.literal(1),
					z.literal(2),
					z.literal(3),
					z.literal(4),
					z.literal(5),
				]),
			}),
		},
		async (args) => {
			const hdmiInput = Number(args['input']) as 1 | 2 | 3 | 4 | 5
			const result = await court.setHdmiInput(hdmiInput)
			return structuredTextResult(
				`HDMI input ${String(hdmiInput)} sent (${result.reliability}).`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'court_projector_on',
			title: 'Court Projector On',
			description:
				'Send Optoma discrete power-on (32 CD 02) on iTach IR2. Lamp warmup can take 15-30s.',
			inputSchema: {},
		},
		async () => {
			const result = await court.projectorOn()
			return structuredTextResult(
				`Projector ON sent on ${result.connector}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'court_projector_standby',
			title: 'Court Projector Standby',
			description: 'Send Optoma discrete standby (32 CD 33) on iTach IR2.',
			inputSchema: {},
		},
		async () => {
			const result = await court.projectorStandby()
			return structuredTextResult(
				`Projector standby sent on ${result.connector}.`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'court_set_rotosphere',
			title: 'Set Court Rotosphere',
			description:
				'Send a Chauvet IRC-6 command to the Rotosphere on iTach IR3 (blaster). Black Out, Manual, and Red were observed on the court. Auto, colors, strobe, and most other buttons are Flipper conversions and are not reliable yet — circle back to learn them.',
			...buildToolInputSchema({
				action: z.enum(rotosphereActions),
			}),
		},
		async (args) => {
			const action = String(
				args['action'],
			) as (typeof rotosphereActions)[number]
			const result = await court.setRotosphere(action)
			return structuredTextResult(
				`Rotosphere ${action} sent (${result.reliability}). ${result.notes}`,
				result,
			)
		},
	)

	registerTool(
		{
			name: 'court_shutdown',
			title: 'Shut Down Court Projector',
			description:
				'Send projector standby. Optionally also send Rotosphere Black Out. HDMI switch power/auto were never learned and are not sent.',
			...buildToolInputSchema({
				rotosphereBlackOut: z.boolean().optional(),
			}),
		},
		async (args) => {
			const result = await court.shutdown({
				rotosphereBlackOut: Boolean(args['rotosphereBlackOut']),
			})
			return structuredTextResult(
				`Court shutdown sent. ${result.notes}`,
				result,
			)
		},
	)
}
