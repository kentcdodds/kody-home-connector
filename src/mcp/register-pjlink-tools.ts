import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
import { z } from 'zod'
import {
	isPjlinkProjectorSelectionError,
	type createPjlinkAdapter,
} from '../adapters/pjlink/index.ts'
import {
	pjlinkAvMuteModes,
	pjlinkInputClasses,
} from '../adapters/pjlink/protocol.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type PjlinkToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type PjlinkRegisteredToolDescriptor = PjlinkToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type PjlinkToolHandler = (
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

function pjlinkSelectionErrorResult(error: unknown): CallToolResult | null {
	if (!isPjlinkProjectorSelectionError(error)) {
		return null
	}
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: error.message,
			},
		],
		structuredContent: {
			error: {
				code: error.code,
				message: error.message,
				projectorId: error.projectorId ?? null,
				name: error.name ?? null,
			},
		},
	}
}

async function handleExpectedPjlinkError(
	handler: () => Promise<CallToolResult> | CallToolResult,
) {
	try {
		return await handler()
	} catch (error) {
		const result = pjlinkSelectionErrorResult(error)
		if (result) return result
		throw error
	}
}

function getSelector(args: Record<string, unknown>) {
	return {
		projectorId:
			args['projectorId'] == null ? undefined : String(args['projectorId']),
		name: args['name'] == null ? undefined : String(args['name']),
		host: args['host'] == null ? undefined : String(args['host']),
	}
}

export function registerPjlinkHomeConnectorTools(input: {
	registerTool: (
		descriptor: PjlinkRegisteredToolDescriptor,
		handler: PjlinkToolHandler,
	) => void
	pjlink: ReturnType<typeof createPjlinkAdapter>
}) {
	const { registerTool, pjlink } = input

	const selectorShape = {
		projectorId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		host: z.string().min(1).optional(),
	}

	registerTool(
		{
			name: 'pjlink_scan_projectors',
			title: 'Scan PJLink Projectors',
			description:
				'Probe configured CIDRs plus extra hosts on TCP 4352 for PJLink Class 1 greetings (PJLINK 0 / PJLINK 1). Persists discovered projectors locally. The court Optoma at 192.168.0.128 is probed by default even when that subnet is not on the connector NIC.',
			inputSchema: {},
		},
		async () => {
			const projectors = await pjlink.scan()
			return structuredTextResult(
				projectors.length === 0
					? 'No PJLink projectors are currently known after the scan.'
					: `Scan complete. ${String(projectors.length)} PJLink projector(s) are known after the scan.`,
				{
					projectors,
					diagnostics: pjlink.getDiscoveryDiagnostics(),
				},
			)
		},
	)

	registerTool(
		{
			name: 'pjlink_list_projectors',
			title: 'List PJLink Projectors',
			description:
				'List locally known PJLink projectors with host, MAC, adoption state, and whether a password is stored.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = await pjlink.getStatus()
			return structuredTextResult(
				status.projectors.length === 0
					? 'No PJLink projectors are currently known.'
					: status.projectors
							.map(
								(projector) =>
									`- ${projector.name} (${projector.projectorId}) adopted=${String(projector.adopted)} host=${projector.host}`,
							)
							.join('\n'),
				status,
			)
		},
	)

	const adoptSchema = buildToolInputSchema({
		projectorId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		host: z.string().min(1).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		macAddress: z.string().min(1).optional(),
		password: z.string().min(1).optional(),
	})

	registerTool(
		{
			name: 'pjlink_adopt_projector',
			title: 'Adopt PJLink Projector',
			description:
				'Register a PJLink projector for control. Pass a discovered projectorId, or register explicitly with host (and optional MAC/name). Court Optoma: host 192.168.0.128, MAC 00:50:41:B2:FD:09, no password. After full projector off the LAN goes dark, so adopt-by-IP still works when scan cannot reach it.',
			inputSchema: markSecretInputFields(adoptSchema.inputSchema, [
				'password',
			]) as Record<string, unknown>,
			sdkInputSchema: adoptSchema.sdkInputSchema,
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const projector = await pjlink.adoptProjector({
					projectorId:
						args['projectorId'] == null
							? undefined
							: String(args['projectorId']),
					name: args['name'] == null ? undefined : String(args['name']),
					host: args['host'] == null ? undefined : String(args['host']),
					port: args['port'] == null ? undefined : Number(args['port']),
					macAddress:
						args['macAddress'] == null ? undefined : String(args['macAddress']),
					password:
						args['password'] == null ? undefined : String(args['password']),
				})
				return structuredTextResult(
					`Adopted PJLink projector ${projector.name} at ${projector.host}.`,
					{ projector },
				)
			})
		},
	)

	const selectorSchema = buildToolInputSchema(selectorShape)

	registerTool(
		{
			name: 'pjlink_forget_projector',
			title: 'Forget PJLink Projector',
			description: 'Remove a PJLink projector from local connector storage.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const projector = await pjlink.forgetProjector(getSelector(args))
				return structuredTextResult(
					`Forgot PJLink projector ${projector.name}.`,
					{ projector },
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_get_power',
			title: 'Get PJLink Power Status',
			description:
				'Query PJLink POWR status for an adopted projector: standby, on, cooling, or warming. After full power-off the LAN is dark and this fails until IR/network-standby brings the projector back.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.getPower(getSelector(args))
				return structuredTextResult(
					`${result.projector.name} power is ${result.power}.`,
					result,
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_power_on',
			title: 'Power On PJLink Projector',
			description:
				'Send PJLink %1POWR 1 to an adopted projector. If the projector was fully powered off, LAN/PJLink are unreachable and court flows should fall back to iTach IR2.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.setPower(getSelector(args), 'on')
				return structuredTextResult(
					`Sent PJLink power on to ${result.projector.name}.`,
					result,
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_power_off',
			title: 'Standby PJLink Projector',
			description:
				'Send PJLink %1POWR 0 (standby) to an adopted projector. Verified on the court Optoma: this shuts the lamp down more reliably than iTach IR standby.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.setPower(getSelector(args), 'off')
				return structuredTextResult(
					`Sent PJLink standby to ${result.projector.name}.`,
					result,
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_get_input',
			title: 'Get PJLink Input',
			description: 'Query PJLink INPT on an adopted projector.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.getInput(getSelector(args))
				return structuredTextResult(
					`${result.projector.name} input is ${result.inputClass} ${String(result.channel)} (${result.code}).`,
					result,
				)
			})
		},
	)

	const setInputSchema = buildToolInputSchema({
		...selectorShape,
		inputClass: z.enum(pjlinkInputClasses),
		channel: z.number().int().min(1).max(9),
	})

	registerTool(
		{
			name: 'pjlink_set_input',
			title: 'Set PJLink Input',
			description:
				'Set PJLink INPT on an adopted projector. inputClass is rgb/video/digital/storage/network; channel is 1-9 (digital 1 is typically HDMI).',
			inputSchema: setInputSchema.inputSchema,
			sdkInputSchema: setInputSchema.sdkInputSchema,
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.setInput(getSelector(args), {
					inputClass: String(
						args['inputClass'],
					) as (typeof pjlinkInputClasses)[number],
					channel: Number(args['channel']),
				})
				return structuredTextResult(
					`Set ${result.projector.name} input to ${result.inputClass} ${String(result.channel)}.`,
					result,
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_get_av_mute',
			title: 'Get PJLink AV Mute',
			description: 'Query PJLink AVMT mute state on an adopted projector.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.getAvMute(getSelector(args))
				return structuredTextResult(
					`${result.projector.name} AV mute is ${result.mode}.`,
					result,
				)
			})
		},
	)

	const setAvMuteSchema = buildToolInputSchema({
		...selectorShape,
		mode: z.enum(pjlinkAvMuteModes),
	})

	registerTool(
		{
			name: 'pjlink_set_av_mute',
			title: 'Set PJLink AV Mute',
			description:
				'Set PJLink AVMT on an adopted projector (video-off/on, audio-off/on, av-off/on).',
			inputSchema: setAvMuteSchema.inputSchema,
			sdkInputSchema: setAvMuteSchema.sdkInputSchema,
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.setAvMute(
					getSelector(args),
					String(args['mode']) as (typeof pjlinkAvMuteModes)[number],
				)
				return structuredTextResult(
					`Set ${result.projector.name} AV mute to ${result.mode}.`,
					result,
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_get_lamp',
			title: 'Get PJLink Lamp Status',
			description: 'Query PJLink LAMP hours and on/off state.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.getLamp(getSelector(args))
				const lamp = result.lamps[0]
				return structuredTextResult(
					lamp
						? `${result.projector.name} lamp ${lamp.on ? 'on' : 'off'} at ${String(lamp.hours)} hour(s).`
						: `${result.projector.name} returned no lamp data.`,
					result,
				)
			})
		},
	)

	registerTool(
		{
			name: 'pjlink_get_info',
			title: 'Get PJLink Projector Info',
			description:
				'Read PJLink NAME, INF1 (manufacturer), INF2 (model), INFO, and CLSS from an adopted projector.',
			inputSchema: selectorSchema.inputSchema,
			sdkInputSchema: selectorSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			return await handleExpectedPjlinkError(async () => {
				const result = await pjlink.getInfo(getSelector(args))
				return structuredTextResult(
					`${result.projector.name}: ${result.manufacturer ?? 'unknown'} ${result.model ?? ''}`.trim(),
					result,
				)
			})
		},
	)
}
