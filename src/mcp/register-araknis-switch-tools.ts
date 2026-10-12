import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createAraknisSwitchAdapter } from '../adapters/araknis-switch/index.ts'
import {
	buildToolInputSchema,
	type SdkToolInputSchema,
} from './tool-input-schema.ts'

type AraknisSwitchToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type AraknisSwitchRegisteredToolDescriptor = AraknisSwitchToolDescriptor & {
	sdkInputSchema?: SdkToolInputSchema
}

type AraknisSwitchToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

function structuredTextResult(
	text: string,
	structuredContent: Record<string, unknown>,
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

export function registerAraknisSwitchHomeConnectorTools(input: {
	registerTool: (
		descriptor: AraknisSwitchRegisteredToolDescriptor,
		handler: AraknisSwitchToolHandler,
	) => void
	araknisSwitch: ReturnType<typeof createAraknisSwitchAdapter>
}) {
	const { registerTool, araknisSwitch } = input

	registerTool(
		{
			name: 'araknis_get_status',
			title: 'Get Araknis Switch Status',
			description:
				'Read-only Araknis AN-620 connectivity/configuration readiness snapshot. Reports whether OpEN HTTPS login works and whether VLAN, interface, and LLDP reads are available. Never returns credential values.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = await araknisSwitch.getStatus()
			return structuredTextResult(
				status.config.configured
					? `Araknis switch status: connected=${String(status.connected)}, vlans=${String(status.vlanCount)}, ports=${String(status.portCount)}, lldpSource=${status.api.lldpSource}.`
					: `Araknis switch diagnostics are not fully configured: ${status.config.missingFields.join(', ')}.`,
				status,
			)
		},
	)

	registerTool(
		{
			name: 'araknis_list_vlans',
			title: 'List Araknis VLANs',
			description:
				'Read-only list of VLAN IDs/names/types from the Araknis AN-620 OpEN API (`GET /open/v1/vlans`).',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const vlans = await araknisSwitch.listVlans()
			return structuredTextResult(
				vlans.length === 0
					? 'No VLANs were returned by the Araknis switch.'
					: `Loaded ${vlans.length} VLAN(s) from the Araknis switch.`,
				{ vlans },
			)
		},
	)

	registerTool(
		{
			name: 'araknis_list_ports',
			title: 'List Araknis Ports',
			description:
				'Read-only per-port status from the Araknis AN-620 OpEN API (`GET /open/v1/interfaces`), including description, link/admin state, PVID, tagged/untagged VLAN membership, and derived switchport mode (access/trunk/general).',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const ports = await araknisSwitch.listPorts()
			return structuredTextResult(
				ports.length === 0
					? 'No ports were returned by the Araknis switch.'
					: `Loaded ${ports.length} port(s) from the Araknis switch.`,
				{ ports },
			)
		},
	)

	const vlanMembershipSchema = buildToolInputSchema({
		vlanId: z
			.number()
			.int()
			.min(1)
			.max(4093)
			.describe(
				'VLAN ID to inspect for tagged/untagged port membership (for example 20 for the AP/SSID VLAN).',
			),
	})

	registerTool(
		{
			name: 'araknis_get_vlan_membership',
			title: 'Get Araknis VLAN Membership',
			description:
				'Read-only VLAN membership for one VLAN ID on the Araknis AN-620. Returns tagged ports, untagged ports, PVID hints, and port descriptions/link state so operators can verify whether VLAN 20 is tagged on AP uplink ports.',
			inputSchema: vlanMembershipSchema.inputSchema,
			sdkInputSchema: vlanMembershipSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const vlanId = Number(args['vlanId'])
			const membership = await araknisSwitch.getVlanMembership(vlanId)
			return structuredTextResult(
				`VLAN ${String(vlanId)} membership: ${String(membership.taggedPorts.length)} tagged port(s), ${String(membership.untaggedPorts.length)} untagged port(s).`,
				membership,
			)
		},
	)

	registerTool(
		{
			name: 'araknis_list_lldp_neighbors',
			title: 'List Araknis LLDP Neighbors',
			description:
				'Read-only LLDP remote neighbors from the Araknis AN-620. Prefers OpEN HTTP LLDP resources when present; optionally falls back to SSH `show lldp remote-device` when ARAKNIS_SWITCH_SSH_ENABLED=true. Returns source metadata when LLDP is unavailable.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const result = await araknisSwitch.listLldpNeighbors()
			return structuredTextResult(
				result.neighbors.length === 0
					? `No LLDP neighbors were returned (source=${result.source}).`
					: `Loaded ${result.neighbors.length} LLDP neighbor(s) via ${result.source}.`,
				result,
			)
		},
	)
}
