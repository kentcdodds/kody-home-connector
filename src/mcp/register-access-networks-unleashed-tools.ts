import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
import { z } from 'zod'
import {
	accessNetworksUnleashedRequestConfirmation,
	type createAccessNetworksUnleashedAdapter,
} from '../adapters/access-networks-unleashed/index.ts'
import {
	buildToolInputSchema,
	type SdkToolInputSchema,
} from './tool-input-schema.ts'

type AccessNetworksUnleashedToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type AccessNetworksUnleashedRegisteredToolDescriptor =
	AccessNetworksUnleashedToolDescriptor & {
		sdkInputSchema?: SdkToolInputSchema
	}

type AccessNetworksUnleashedToolHandler = (
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

const requestDangerNotice =
	'HIGH RISK: this issues an authenticated raw AJAX request against a live Access Networks / RUCKUS Unleashed controller. setconf and docmd actions can disconnect clients, take SSIDs offline, reboot access points, or otherwise disrupt local connectivity. Only use it when you are highly certain the request is necessary and correct.'

const requestDescription = `${requestDangerNotice}

Posts an authenticated text/xml AJAX payload using the stored credentials and the managed session (cookie jar + X-CSRF-Token). getstat/docmd go to POST {host}/admin/_cmdstat.jsp; getconf/setconf go to POST {host}/admin/_conf.jsp. The session is reused across calls and re-established automatically when it expires.

Inputs:
- action: 'getstat' | 'getconf' | 'setconf' | 'docmd'.
- comp: Unleashed component name such as 'system', 'stamgr', 'wlansvc-list', 'apStat', 'eventd'.
- xmlBody: inner XML appended inside the <ajax-request> envelope (may be empty for getconf).
- updater: optional updater string. Required by getconf/setconf/docmd when omitted the connector generates "<comp>.<timestamp>.<rand>"; getstat omits updater unless supplied.
- allowInsecureTls: optional boolean. When omitted, falls back to the connector-wide ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS setting (off unless explicitly enabled). Only applies to the actual AJAX post; the connector-wide setting also governs session establishment so concurrent callers cannot disagree about login-time TLS.

Returns the raw XML response and a best-effort parsed object.`

export function registerAccessNetworksUnleashedHomeConnectorTools(input: {
	registerTool: (
		descriptor: AccessNetworksUnleashedRegisteredToolDescriptor,
		handler: AccessNetworksUnleashedToolHandler,
	) => void
	accessNetworksUnleashed: ReturnType<
		typeof createAccessNetworksUnleashedAdapter
	>
}) {
	const { registerTool, accessNetworksUnleashed } = input

	registerTool(
		{
			name: 'access_networks_unleashed_scan_controllers',
			title: 'Scan Access Networks Unleashed Controllers',
			description:
				'Probe local-network scan CIDRs for Access Networks / RUCKUS Unleashed controllers, persist discovered controllers locally, and return discovery diagnostics.',
			inputSchema: {},
		},
		async () => {
			const controllers = await accessNetworksUnleashed.scan()
			return structuredTextResult(
				controllers.length === 0
					? 'No Access Networks Unleashed controllers were discovered.'
					: `Discovered ${controllers.length} Access Networks Unleashed controller(s).`,
				{
					controllers,
					diagnostics: accessNetworksUnleashed.getDiscoveryDiagnostics(),
				},
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_list_controllers',
			title: 'List Access Networks Unleashed Controllers',
			description:
				'List locally persisted Access Networks Unleashed controllers, whether one is adopted, and whether credentials are stored.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const controllers = await accessNetworksUnleashed.listControllers()
			return structuredTextResult(
				controllers.length === 0
					? 'No Access Networks Unleashed controllers are currently known.'
					: controllers
							.map(
								(controller) =>
									`- ${controller.name} (${controller.controllerId}) adopted=${String(controller.adopted)} credentials=${String(controller.hasStoredCredentials)}`,
							)
							.join('\n'),
				{
					controllers,
				},
			)
		},
	)

	const controllerIdSchema = buildToolInputSchema({
		controllerId: z.string().min(1),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_adopt_controller',
			title: 'Adopt Access Networks Unleashed Controller',
			description:
				'Mark a discovered Access Networks Unleashed controller as the adopted controller for live reads and write operations.',
			inputSchema: controllerIdSchema.inputSchema,
			sdkInputSchema: controllerIdSchema.sdkInputSchema,
		},
		async (args) => {
			const controller = await accessNetworksUnleashed.adoptController({
				controllerId: String(args['controllerId'] ?? ''),
			})
			return structuredTextResult(
				`Adopted Access Networks Unleashed controller ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_remove_controller',
			title: 'Remove Access Networks Unleashed Controller',
			description:
				'Remove a locally persisted Access Networks Unleashed controller and any stored credentials.',
			inputSchema: controllerIdSchema.inputSchema,
			sdkInputSchema: controllerIdSchema.sdkInputSchema,
		},
		async (args) => {
			const controller = await accessNetworksUnleashed.removeController({
				controllerId: String(args['controllerId'] ?? ''),
			})
			return structuredTextResult(
				`Removed Access Networks Unleashed controller ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	const credentialsSchema = buildToolInputSchema({
		controllerId: z.string().min(1),
		username: z.string().min(1),
		password: z.string().min(1),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_set_credentials',
			title: 'Set Access Networks Unleashed Credentials',
			description:
				'Store username/password locally for an Access Networks Unleashed controller so the connector can authenticate later.',
			inputSchema: markSecretInputFields(credentialsSchema.inputSchema, [
				'username',
				'password',
			]) as Record<string, unknown>,
			sdkInputSchema: credentialsSchema.sdkInputSchema,
		},
		async (args) => {
			const controller = await accessNetworksUnleashed.setCredentials({
				controllerId: String(args['controllerId'] ?? ''),
				username: String(args['username'] ?? ''),
				password: String(args['password'] ?? ''),
			})
			return structuredTextResult(
				`Stored Access Networks Unleashed credentials for ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_authenticate_controller',
			title: 'Authenticate Access Networks Unleashed Controller',
			description:
				'Attempt an Access Networks Unleashed login using stored credentials for the adopted controller or the specified controller.',
			...buildToolInputSchema({
				controllerId: z.string().min(1).optional(),
			}),
		},
		async (args) => {
			const controller = await accessNetworksUnleashed.authenticate(
				args['controllerId'] == null ? undefined : String(args['controllerId']),
			)
			return structuredTextResult(
				`Authenticated Access Networks Unleashed controller ${controller.name}.`,
				{
					controller,
				},
			)
		},
	)

	const requestSchema = buildToolInputSchema({
		action: z
			.enum(['getstat', 'getconf', 'setconf', 'docmd'])
			.describe(
				"Unleashed AJAX action: 'getstat' for status reads via _cmdstat.jsp, 'getconf' for config reads via _conf.jsp, 'setconf' for object mutations, 'docmd' for command-style operations such as block client or restart AP.",
			),
		comp: z
			.string()
			.min(1)
			.describe(
				"Unleashed component name to target (for example 'system', 'stamgr', 'wlansvc-list', 'apStat', 'eventd').",
			),
		xmlBody: z
			.string()
			.describe(
				'Inner XML appended inside the <ajax-request> envelope. May be empty for getconf.',
			),
		updater: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional updater attribute. Defaults to a generated "<comp>.<timestamp>.<rand>" string for getconf/setconf/docmd; omitted on getstat unless supplied.',
			),
		allowInsecureTls: z
			.boolean()
			.optional()
			.describe(
				'Optional override for accepting self-signed LAN certificates. When omitted, falls back to ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS (off unless explicitly enabled).',
			),
		acknowledgeHighRisk: z
			.literal(true)
			.describe(
				'Must be true. Set this only when you are highly certain the requested raw AJAX call is necessary and correct.',
			),
		reason: z
			.string()
			.min(20)
			.max(500)
			.describe(
				'Short operator justification. Be specific about why this raw request is necessary right now.',
			),
		confirmation: z
			.literal(accessNetworksUnleashedRequestConfirmation)
			.describe(
				'Exact confirmation phrase required by the tool. The tool rejects any other value.',
			),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_request',
			title: 'Access Networks Unleashed Raw Request',
			description: requestDescription,
			inputSchema: requestSchema.inputSchema,
			sdkInputSchema: requestSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.request({
				action: args['action'] as 'getstat' | 'getconf' | 'setconf' | 'docmd',
				comp: String(args['comp'] ?? ''),
				xmlBody: String(args['xmlBody'] ?? ''),
				updater: args['updater'] == null ? undefined : String(args['updater']),
				allowInsecureTls:
					typeof args['allowInsecureTls'] === 'boolean'
						? args['allowInsecureTls']
						: undefined,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				`Completed Access Networks Unleashed ${result.action} on ${result.comp}.`,
				result,
			)
		},
	)
}
