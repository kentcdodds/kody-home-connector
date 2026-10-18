import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
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
				'Read-only Araknis AN-620 connectivity/configuration readiness snapshot. Reports whether OpEN HTTPS login works and whether system info, VLAN, interface, PoE, and LLDP reads are available. Reuses the managed session cookie (keepalive). Never returns credential values.',
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
					? `Araknis switch status: connected=${String(status.connected)}, vlans=${String(status.vlanCount)}, ports=${String(status.portCount)}, poe=${String(status.poePortCount)} (${status.api.poeSource}), lldpSource=${status.api.lldpSource}.`
					: `Araknis switch diagnostics are not fully configured: ${status.config.missingFields.join(', ')}.`,
				status,
			)
		},
	)

	const credentialsSchema = buildToolInputSchema({
		username: z
			.string()
			.min(1)
			.describe('Araknis switch management username to store locally.'),
		password: z
			.string()
			.min(1)
			.describe('Araknis switch management password to store locally.'),
	})

	registerTool(
		{
			name: 'araknis_set_credentials',
			title: 'Set Araknis Switch Credentials',
			description:
				'Store Araknis AN-620 management username and password locally in the home connector SQLite database, encrypted with HOME_CONNECTOR_SHARED_SECRET. Prefer the LAN setup page at /araknis-switch/setup so secrets never enter chat. Never logs or returns the values.',
			inputSchema: markSecretInputFields(credentialsSchema.inputSchema, [
				'username',
				'password',
			]) as Record<string, unknown>,
			sdkInputSchema: credentialsSchema.sdkInputSchema,
		},
		async (args) => {
			const status = await araknisSwitch.setCredentials(
				String(args['username'] ?? ''),
				String(args['password'] ?? ''),
			)
			return structuredTextResult(
				'Stored Araknis switch credentials locally.',
				{
					status,
				},
			)
		},
	)

	registerTool(
		{
			name: 'araknis_clear_credentials',
			title: 'Clear Araknis Switch Credentials',
			description:
				'Delete the locally stored Araknis AN-620 management username and password from connector SQLite and drop any cached OpEN session.',
			inputSchema: {},
		},
		async () => {
			const status = await araknisSwitch.clearCredentials()
			return structuredTextResult('Cleared Araknis switch credentials.', status)
		},
	)

	registerTool(
		{
			name: 'araknis_authenticate',
			title: 'Authenticate Araknis Switch',
			description:
				'Establish (or refresh) an OpEN HTTPS session against the configured Araknis AN-620 using stored credentials. The connector keeps the session cookie for subsequent read tools (keepalive) and re-logins automatically on 401/403. Never returns credential values.',
			inputSchema: {},
		},
		async () => {
			const status = await araknisSwitch.authenticate()
			return structuredTextResult(
				'Authenticated Araknis switch OpEN session.',
				{ status },
			)
		},
	)

	registerTool(
		{
			name: 'araknis_get_system_info',
			title: 'Get Araknis System Info',
			description:
				'Read-only system identity from OpEN (`GET /open/v1/system1213`, `/open/v1/systemmisc`, `/open/v1/registry`, `/open/v1/dot1dbaseconfig`): sysName/sysDescr/location/contact, hostname, uptime, burned-in MAC, machine model/type, bridge address, and port count.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const system = await araknisSwitch.getSystemInfo()
			return structuredTextResult(
				`Araknis system: name=${system.sysName ?? system.hostname ?? 'unknown'}, model=${system.machineModel ?? 'unknown'}, ports=${String(system.baseNumPorts ?? 'unknown')}.`,
				{ system },
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
			name: 'araknis_list_poe_status',
			title: 'List Araknis PoE Status',
			description:
				'Read-only PoE status for Araknis AN-620 ports. Prefers OpEN HTTPS PoE resources when present (not documented in Dell OpEN 6.8.0 — probed by name). Optionally falls back to SSH `show power inline` when ARAKNIS_SWITCH_SSH_ENABLED=true. Returns source metadata when PoE is unavailable. Never changes PoE admin state.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const poe = await araknisSwitch.listPoeStatus()
			return structuredTextResult(
				poe.ports.length === 0
					? `No PoE port status was returned (source=${poe.source}).`
					: `Loaded PoE status for ${poe.ports.length} port(s) via ${poe.source}.`,
				poe,
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

	registerTool(
		{
			name: 'araknis_get_config_snapshot',
			title: 'Get Araknis Config Snapshot',
			description:
				'Read-only snapshot of the running switch view used for diagnostics and as the baseline for any future safe writes: system identity, VLAN list, per-port membership, and PoE status (when available). Does not mutate the switch. Write tools are intentionally not shipped yet — OpEN PUT for interfaces/VLANs/PoE is high-risk and not verified against this AN-620.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const snapshot = await araknisSwitch.getConfigSnapshot()
			return structuredTextResult(
				`Captured Araknis config snapshot at ${snapshot.capturedAt}: ${String(snapshot.vlans.length)} VLAN(s), ${String(snapshot.ports.length)} port(s), PoE source=${snapshot.poe.source}.`,
				snapshot,
			)
		},
	)
}
