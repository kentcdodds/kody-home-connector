import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-bot/connector-kit/schema'
import { z } from 'zod'
import {
	accessNetworksUnleashedDangerousListSetconfConfirmation,
	accessNetworksUnleashedRequestConfirmation,
	accessNetworksUnleashedWlanWriteConfirmation,
	type createAccessNetworksUnleashedAdapter,
} from '../adapters/access-networks-unleashed/index.ts'
import {
	redactSecretAttributes,
	redactSecretsInXmlText,
} from '../adapters/access-networks-unleashed/wlan-xml.ts'
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

Posts an authenticated text/xml AJAX payload using the stored credentials and the managed session (cookie jar + X-CSRF-Token). getstat/docmd go to POST {host}/admin/_cmdstat.jsp; getconf/setconf/addobj/updobj/delobj go to POST {host}/admin/_conf.jsp. The session is reused across calls and re-established automatically when it expires.

WLAN WRITES: this raw tool refuses every setconf on wlansvc-list or containing a <wlansvc>. On Unleashed 200.x a single-<wlansvc> setconf is applied to the FIRST WLAN in the list regardless of id (Oct 12 and Oct 17 incidents, both overwrote friendlyfamily). Use access_networks_unleashed_update_wlan (updobj by id), access_networks_unleashed_clone_wlan (addobj), and access_networks_unleashed_delete_wlan (delobj by id) instead.

SECRETS: WPA/SAE passphrases, guest-pass values, and every x- obfuscated attribute are redacted from the returned XML and parsed object.

Inputs:
- action: 'getstat' | 'getconf' | 'setconf' | 'docmd' | 'addobj' | 'updobj' | 'delobj'. setconf is refused on any *-list comp unless the dangerous positional escape hatch is armed. addobj/updobj/delobj on wlansvc-list additionally require WLAN writes to be enabled (wlanWritesEnabled) and an explicit id (updobj/delobj) or no id (addobj), and get no snapshot/rollback — prefer the typed WLAN tools.
- comp: Unleashed component name such as 'system', 'stamgr', 'wlansvc-list', 'apStat', 'eventd'.
- xmlBody: inner XML appended inside the <ajax-request> envelope (may be empty for getconf).
- updater: optional updater string. Required by getconf/setconf/docmd when omitted the connector generates "<comp>.<timestamp>.<rand>"; getstat omits updater unless supplied.
- caller: optional ajax-request caller attribute. When omitted, getstat vap/wlangroup bodies default to caller="SCI" (aioruckus ground truth). Bare &lt;vap/&gt; bodies are normalized to &lt;vap INTERVAL-STATS="no" LEVEL="1"/&gt;.
- allowInsecureTls: optional boolean. When omitted, falls back to the connector-wide ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS setting (off unless explicitly enabled). Only applies to the actual AJAX post; the connector-wide setting also governs session establishment so concurrent callers cannot disagree about login-time TLS.
- allowDangerousPositionalListSetconf + dangerousListSetconfConfirmation: escape hatch for setconf on *-list only. Both required; confirmation must be the exact phrase documenting that you understand positional overwrite. Prefer addobj/updobj/delobj. For wlansvc-list this also requires wlanWritesEnabled.

Returns the raw XML response and a best-effort parsed object.`

const wlanWriteDangerNotice =
	'DISABLED BY DEFAULT: refuses unless Kent enabled access_networks_unleashed_set_config { wlanWritesEnabled: true } for a supervised test. HIGH RISK: mutates live Unleashed WLAN configuration on the adopted controller. Writes use the Unleashed object actions (addobj / updobj / delobj on wlansvc-list) and every payload must carry an explicit target id (or be an addobj create). Before writing, the tool takes a restorable snapshot (DECRYPT_X so passphrases can be restored; secrets are never returned) and refuses if the list is damaged or any PSK WLAN secret is missing. After writing it re-reads and, on ANY anomaly (other WLAN changed, id missing/duplicated, id-less entry, failed re-read), rolls back first and then reports.'

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
			.enum([
				'getstat',
				'getconf',
				'setconf',
				'docmd',
				'addobj',
				'updobj',
				'delobj',
			])
			.describe(
				"Unleashed AJAX action: 'getstat' for status reads via _cmdstat.jsp, 'getconf' for config reads via _conf.jsp, 'addobj' / 'updobj' / 'delobj' for object create / update-by-id / delete-by-id on *-list components via _conf.jsp (the Unleashed web UI / aioruckus semantics), 'setconf' for non-list config only (refused on any *-list comp because it is positional), 'docmd' for command-style operations such as block client or restart AP.",
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
		caller: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional ajax-request caller attribute. When omitted, getstat vap/wlangroup bodies default to "SCI".',
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
		allowDangerousPositionalListSetconf: z
			.boolean()
			.optional()
			.describe(
				'Escape hatch only: allow setconf on a *-list component despite positional-overwrite risk. Requires dangerousListSetconfConfirmation.',
			),
		dangerousListSetconfConfirmation: z
			.literal(accessNetworksUnleashedDangerousListSetconfConfirmation)
			.optional()
			.describe(
				`Exact escape-hatch phrase: "${accessNetworksUnleashedDangerousListSetconfConfirmation}"`,
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
				action: args['action'] as
					| 'getstat'
					| 'getconf'
					| 'setconf'
					| 'docmd'
					| 'addobj'
					| 'updobj'
					| 'delobj',
				comp: String(args['comp'] ?? ''),
				xmlBody: String(args['xmlBody'] ?? ''),
				updater: args['updater'] == null ? undefined : String(args['updater']),
				caller: args['caller'] == null ? undefined : String(args['caller']),
				allowInsecureTls:
					typeof args['allowInsecureTls'] === 'boolean'
						? args['allowInsecureTls']
						: undefined,
				allowDangerousPositionalListSetconf:
					args['allowDangerousPositionalListSetconf'] === true,
				dangerousListSetconfConfirmation:
					args['dangerousListSetconfConfirmation'] == null
						? undefined
						: String(args['dangerousListSetconfConfirmation']),
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

	registerTool(
		{
			name: 'access_networks_unleashed_list_wlans',
			title: 'List Access Networks Unleashed WLANs',
			description:
				'Read-only getconf of wlansvc-list. Returns every WLAN with its stable wlansvc id, name, ssid, attributes, and raw XML (secrets redacted). Works even when the list is damaged: entries with no id are listed under anomalies and duplicate ids under duplicateIds (writes refuse until repaired). Prefer this (or get_wlan) before any WLAN write so you target by id, never by list position.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const result = await accessNetworksUnleashed.listWlans()
			return structuredTextResult(
				result.wlans.length === 0
					? 'No WLANs were returned from wlansvc-list.'
					: `Listed ${String(result.wlans.length)} WLAN(s) from wlansvc-list.`,
				result,
			)
		},
	)

	const getWlanSchema = buildToolInputSchema({
		id: z
			.string()
			.min(1)
			.describe(
				'Stable wlansvc id from list_wlans / getconf wlansvc-list (for example "5" for friendlyguest). Never target by list index.',
			),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_get_wlan',
			title: 'Get Access Networks Unleashed WLAN By Id',
			description:
				'Read one WLAN from getconf wlansvc-list by its stable wlansvc id. Returns name, ssid, attributes (including vlan-id, client-isolation, guest/portal fields when present), and the raw <wlansvc> XML. Use this before update_wlan or clone_wlan.',
			inputSchema: getWlanSchema.inputSchema,
			sdkInputSchema: getWlanSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await accessNetworksUnleashed.getWlan({
				id: String(args['id'] ?? ''),
			})
			return structuredTextResult(
				`Read WLAN id ${result.wlan.id}` +
					(result.wlan.name ? ` (${result.wlan.name})` : '') +
					'.',
				result,
			)
		},
	)

	const updateWlanSchema = buildToolInputSchema({
		id: z
			.string()
			.min(1)
			.describe('Stable wlansvc id to update (from list_wlans / get_wlan).'),
		attributes: z
			.record(z.string(), z.string())
			.describe(
				'Only the Unleashed attributes to change (exact names already present on the WLAN). Example: { "vlan-id": "20" } or { "enable-type": "1" } to disable. Sent as a single-id updobj IS_PARTIAL on wlansvc-list — never a list rewrite.',
			),
		acceptUnrestorablePassphrases: z
			.boolean()
			.optional()
			.describe(
				"Default false: the write is refused if any WLAN passphrase could not be captured in the snapshot. Set true only with Kent's explicit acceptance that those passphrases cannot be auto-restored; rollback then restores only their root attributes and never re-creates them. Clone always refuses if the SOURCE passphrase is missing.",
			),
		dryRun: z
			.boolean()
			.optional()
			.describe(
				'When true: take the restorable snapshot, build the exact updobj request, and return it without sending. Does not require wlanWritesEnabled or the high-risk confirmation. Secrets in the planned request are redacted.',
			),
		acknowledgeHighRisk: z
			.literal(true)
			.optional()
			.describe(
				'Required unless dryRun=true. Confirms you intend a live per-WLAN mutation with automatic snapshot/diff/rollback.',
			),
		reason: z
			.string()
			.min(20)
			.max(500)
			.optional()
			.describe(
				'Required unless dryRun=true. Operator justification (≥20 chars). Name the WLAN id and the intended attribute change.',
			),
		confirmation: z
			.literal(accessNetworksUnleashedWlanWriteConfirmation)
			.optional()
			.describe(
				'Required unless dryRun=true. Exact confirmation phrase required by the tool.',
			),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_update_wlan',
			title: 'Update Access Networks Unleashed WLAN By Id',
			description: `${wlanWriteDangerNotice}

Updates one WLAN by wlansvc id. Sends only the changed attributes as updobj + IS_PARTIAL on comp=wlansvc-list (aioruckus do_disable_wlan pattern; id is required on the wire). Attribute names must already exist on the WLAN; secrets, id, and the bogus "radio" attribute are refused. After writing: re-reads, verifies the target changed only as requested and no other WLAN changed; otherwise rolls back.

dryRun=true returns the exact request(s) without sending (works while writes are disabled).

Do not pass the whole WLAN object or a wlansvc-list. Prefer get_wlan first.`,
			inputSchema: updateWlanSchema.inputSchema,
			sdkInputSchema: updateWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const attributesRaw = args['attributes']
			if (
				attributesRaw == null ||
				typeof attributesRaw !== 'object' ||
				Array.isArray(attributesRaw)
			) {
				throw new Error(
					'attributes must be an object of string→string Unleashed attribute names.',
				)
			}
			const attributes: Record<string, string> = {}
			for (const [key, value] of Object.entries(
				attributesRaw as Record<string, unknown>,
			)) {
				attributes[key] = String(value)
			}
			const dryRun = args['dryRun'] === true
			const result = await accessNetworksUnleashed.updateWlan({
				id: String(args['id'] ?? ''),
				attributes,
				acceptUnrestorablePassphrases:
					args['acceptUnrestorablePassphrases'] === true,
				dryRun,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				dryRun
					? `Dry-run update for WLAN id ${result.id}: nothing sent.`
					: `Updated WLAN id ${result.id}; safety check passed (no rollback).`,
				{
					dryRun: result.dryRun,
					id: result.id,
					before: {
						id: result.before.id,
						name: result.before.name,
						ssid: result.before.ssid,
						attributes: redactSecretAttributes(result.before.attributes),
					},
					after: result.after
						? {
								id: result.after.id,
								name: result.after.name,
								ssid: result.after.ssid,
								attributes: redactSecretAttributes(result.after.attributes),
							}
						: null,
					appliedAttributes: result.appliedAttributes,
					safety: result.safety,
					requestAction: result.requestAction,
					requestXml: redactSecretsInXmlText(result.requestXml),
					requests: result.requests,
				},
			)
		},
	)

	const cloneWlanSchema = buildToolInputSchema({
		sourceId: z
			.string()
			.min(1)
			.describe(
				'Existing wlansvc id to clone (copies guest portal, client isolation, access VLAN, and all other settings).',
			),
		overrides: z
			.object({
				name: z.string().min(1).optional(),
				ssid: z.string().min(1).optional(),
				description: z.string().optional(),
				vlanId: z.union([z.string(), z.number()]).optional(),
				clientIsolation: z.string().optional(),
				radioBand: z
					.enum(['all', '2.4ghz', '5ghz', '6ghz'])
					.optional()
					.describe(
						'Radio band restriction, mapped onto the real Unleashed flags wlan-bind-24g / wlan-bind-5g / wlan-bind-6g ("2.4ghz" = 24g true, 5g false, 6g false; "all" = all true).',
					),
				attributes: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						'Exact Unleashed root attribute overrides merged on top of the cloned XML. Names must already exist on the source (e.g. "enable-type": "1" creates it disabled). id/create-time are stripped before create; secrets cannot be overridden.',
					),
			})
			.optional()
			.describe(
				'Optional overrides applied after cloning the full source XML (id removed). Typical: name/ssid and radioBand for a 2.4 GHz-only copy.',
			),
		acceptUnrestorablePassphrases: z
			.boolean()
			.optional()
			.describe(
				"Default false: the write is refused if any WLAN passphrase could not be captured in the snapshot. Set true only with Kent's explicit acceptance that those passphrases cannot be auto-restored; rollback then restores only their root attributes and never re-creates them. Clone always refuses if the SOURCE passphrase is missing.",
			),
		dryRun: z
			.boolean()
			.optional()
			.describe(
				'When true: snapshot + build the exact addobj create payload and return it without sending. Does not require wlanWritesEnabled or the high-risk confirmation. Secrets in the planned request are redacted.',
			),
		acknowledgeHighRisk: z.literal(true).optional(),
		reason: z.string().min(20).max(500).optional(),
		confirmation: z
			.literal(accessNetworksUnleashedWlanWriteConfirmation)
			.optional(),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_clone_wlan',
			title: 'Clone Access Networks Unleashed WLAN By Id',
			description: `${wlanWriteDangerNotice}

Creates a new WLAN by cloning an existing one by wlansvc id. Starts from getconf wlansvc-standard-template, lays the source WLAN on top (source wins), strips id/create-time, applies optional overrides, and sends ONE addobj on wlansvc-list (controller assigns the id). Refuses duplicate names/SSIDs. After write verifies exactly one new id appeared matching the payload and no other WLAN changed; otherwise restores the snapshot.

dryRun=true returns the exact addobj request without sending (works while writes are disabled).`,
			inputSchema: cloneWlanSchema.inputSchema,
			sdkInputSchema: cloneWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const overridesRaw = args['overrides']
			let overrides:
				| {
						name?: string
						ssid?: string
						description?: string
						vlanId?: string | number
						clientIsolation?: string
						radioBand?: 'all' | '2.4ghz' | '5ghz' | '6ghz'
						attributes?: Record<string, string>
				  }
				| undefined
			if (overridesRaw != null && typeof overridesRaw === 'object') {
				const record = overridesRaw as Record<string, unknown>
				const attributesValue = record['attributes']
				const attributes =
					attributesValue != null &&
					typeof attributesValue === 'object' &&
					!Array.isArray(attributesValue)
						? Object.fromEntries(
								Object.entries(attributesValue as Record<string, unknown>).map(
									([key, value]) => [key, String(value)],
								),
							)
						: undefined
				const radioBand = record['radioBand']
				overrides = {
					name: record['name'] == null ? undefined : String(record['name']),
					ssid: record['ssid'] == null ? undefined : String(record['ssid']),
					description:
						record['description'] == null
							? undefined
							: String(record['description']),
					vlanId:
						record['vlanId'] == null
							? undefined
							: (record['vlanId'] as string | number),
					clientIsolation:
						record['clientIsolation'] == null
							? undefined
							: String(record['clientIsolation']),
					radioBand:
						radioBand === 'all' ||
						radioBand === '2.4ghz' ||
						radioBand === '5ghz' ||
						radioBand === '6ghz'
							? radioBand
							: undefined,
					attributes,
				}
			}
			const dryRun = args['dryRun'] === true
			const result = await accessNetworksUnleashed.cloneWlan({
				sourceId: String(args['sourceId'] ?? ''),
				overrides,
				acceptUnrestorablePassphrases:
					args['acceptUnrestorablePassphrases'] === true,
				dryRun,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				dryRun
					? `Dry-run clone of WLAN id ${result.sourceId}: nothing sent.`
					: `Cloned WLAN id ${result.sourceId} → new id ${result.created?.id ?? '?'}; safety check passed (no rollback).`,
				{
					dryRun: result.dryRun,
					sourceId: result.sourceId,
					source: {
						id: result.source.id,
						name: result.source.name,
						ssid: result.source.ssid,
					},
					created: result.created
						? {
								id: result.created.id,
								name: result.created.name,
								ssid: result.created.ssid,
								attributes: redactSecretAttributes(result.created.attributes),
							}
						: null,
					overridesApplied: redactSecretAttributes(result.overridesApplied),
					safety: result.safety,
					requestAction: result.requestAction,
					requestXml: result.requestXml,
					requests: result.requests,
					warnings: result.warnings,
				},
			)
		},
	)

	registerTool(
		{
			name: 'access_networks_unleashed_check_wlan_write_readiness',
			title: 'Check Access Networks Unleashed WLAN Write Readiness',
			description:
				'Read-only. Reads wlansvc-list twice with DECRYPT_X (secrets stay in memory, never returned) and reports whether a WLAN write could be fully snapshotted and rolled back right now: no id-less or duplicate entries, every WPA/SAE PSK WLAN has its passphrase captured, and two consecutive reads agree. Run this before any WLAN write.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const result = await accessNetworksUnleashed.checkWlanWriteReadiness()
			return structuredTextResult(
				result.ready
					? 'WLAN writes are ready: snapshot would be complete and restorable.'
					: `WLAN writes are NOT ready: ${result.problems.join('; ')}`,
				result,
			)
		},
	)

	const deleteWlanSchema = buildToolInputSchema({
		id: z
			.string()
			.min(1)
			.describe('Stable wlansvc id to delete (from list_wlans / get_wlan).'),
		expectedName: z
			.string()
			.min(1)
			.describe(
				'Current name of that WLAN. The delete is refused unless it matches, guarding against a wrong id.',
			),
		acceptUnrestorablePassphrases: z
			.boolean()
			.optional()
			.describe(
				"Default false: the write is refused if any WLAN passphrase could not be captured in the snapshot. Set true only with Kent's explicit acceptance that those passphrases cannot be auto-restored; rollback then restores only their root attributes and never re-creates them. Clone always refuses if the SOURCE passphrase is missing.",
			),
		dryRun: z
			.boolean()
			.optional()
			.describe(
				'When true: snapshot + build the exact delobj request and return it without sending. Does not require wlanWritesEnabled or the high-risk confirmation.',
			),
		acknowledgeHighRisk: z.literal(true).optional(),
		reason: z.string().min(20).max(500).optional(),
		confirmation: z
			.literal(accessNetworksUnleashedWlanWriteConfirmation)
			.optional(),
	})

	registerTool(
		{
			name: 'access_networks_unleashed_delete_wlan',
			title: 'Delete Access Networks Unleashed WLAN By Id',
			description: `${wlanWriteDangerNotice}

Deletes one WLAN by wlansvc id with delobj (<wlansvc id='N'/>, the aioruckus / ruckus-go delete). Requires expectedName to match. After write verifies only that id disappeared; otherwise re-creates it from the snapshot (addobj; the controller may assign a new id).

dryRun=true returns the exact delobj request without sending (works while writes are disabled).`,
			inputSchema: deleteWlanSchema.inputSchema,
			sdkInputSchema: deleteWlanSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const dryRun = args['dryRun'] === true
			const result = await accessNetworksUnleashed.deleteWlan({
				id: String(args['id'] ?? ''),
				expectedName: String(args['expectedName'] ?? ''),
				acceptUnrestorablePassphrases:
					args['acceptUnrestorablePassphrases'] === true,
				dryRun,
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
			})
			return structuredTextResult(
				dryRun
					? `Dry-run delete for WLAN id ${result.id}: nothing sent.`
					: `Deleted WLAN id ${result.id} (${result.deleted.name ?? '?'}); safety check passed (no rollback).`,
				{
					dryRun: result.dryRun,
					id: result.id,
					deleted: {
						id: result.deleted.id,
						name: result.deleted.name,
						ssid: result.deleted.ssid,
					},
					safety: result.safety,
					requestAction: result.requestAction,
					requestXml: result.requestXml,
					requests: result.requests,
					warnings: result.warnings,
				},
			)
		},
	)
}
