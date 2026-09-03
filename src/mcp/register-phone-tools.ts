import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	defaultCastMdnsServiceType,
	gmsPackageName,
	googleHomePackageName,
	phoneMdnsScanTimeoutMs,
	phoneOfflineError,
	teslaPackageName,
	youtubePackageName,
	type createPhoneAdapter,
	type PhoneCallResult,
	type PhoneStructuredError,
} from '../adapters/phone/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type PhoneToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type PhoneRegisteredToolDescriptor = PhoneToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type PhoneToolHandler = (
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

function phoneErrorResult(error: PhoneStructuredError): CallToolResult {
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: error.error.message,
			},
		],
		structuredContent: {
			ok: false,
			error: error.error,
		},
	}
}

function resultFromCall(result: PhoneCallResult): CallToolResult {
	if (!result.ok) return phoneErrorResult(result)
	return structuredTextResult('Android companion call completed.', {
		ok: true,
		payload: result.payload,
	})
}

async function callPhoneTool(
	phone: ReturnType<typeof createPhoneAdapter>,
	tool: string,
	args: Record<string, unknown> = {},
	options?: { timeoutMs?: number },
) {
	const blocked = phone.getCallReadiness()
	if (blocked) return phoneErrorResult(blocked)
	return resultFromCall(await phone.call(tool, args, options))
}

const calendarContactsNotice =
	'These tools can read calendar metadata and contact counts from the connected Android phone. They do not return contact payloads in v1.'

const settingsNotice =
	'phone_open_app_settings opens the Android Settings screen for a package on the connected phone.'

export function registerPhoneHomeConnectorTools(input: {
	registerTool: (
		descriptor: PhoneRegisteredToolDescriptor,
		handler: PhoneToolHandler,
	) => void
	phone: ReturnType<typeof createPhoneAdapter>
}) {
	const { registerTool, phone } = input

	registerTool(
		{
			name: 'phone_status',
			title: 'Get Android Phone Companion Status',
			description:
				'Read whether the Android companion WebSocket is connected, the last hello payload, and lastSeenAt. Returns structured status even when the phone is offline.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = phone.getStatus()
			return structuredTextResult(
				status.connected
					? `Android companion ${status.lastHello?.deviceName ?? status.deviceId ?? 'phone'} is connected.`
					: status.tokenConfigured
						? phoneOfflineError.message
						: 'Phone token not configured.',
				{
					ok: true,
					...status,
				},
			)
		},
	)

	const packageNameSchema = buildToolInputSchema({
		packageName: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Android package name. When omitted, the phone dumps this companion app plus Tesla, Google Home, YouTube, and GMS.',
			),
	})

	registerTool(
		{
			name: 'phone_permissions',
			title: 'Get Android App Permissions',
			description: `Read runtime permission state for an Android package on the connected phone. ${calendarContactsNotice}`,
			inputSchema: packageNameSchema.inputSchema,
			sdkInputSchema: packageNameSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const packageName =
				args['packageName'] == null ? undefined : String(args['packageName'])
			return await callPhoneTool(
				phone,
				'phone_permissions',
				packageName ? { packageName } : {},
			)
		},
	)

	registerTool(
		{
			name: 'phone_calendars',
			title: 'List Android Calendars',
			description: `List calendars visible to the Android companion. ${calendarContactsNotice}`,
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_calendars'),
	)

	registerTool(
		{
			name: 'phone_contacts_summary',
			title: 'Get Android Contacts Summary',
			description: `Return contact counts only from the Android companion. No contact payloads are returned in v1. ${calendarContactsNotice}`,
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_contacts_summary'),
	)

	registerTool(
		{
			name: 'phone_network',
			title: 'Get Android Network Status',
			description:
				'Read SSID, IP, VPN, metered, link, DNS, and wifiMulticast state from the connected Android phone.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_network'),
	)

	const mdnsSchema = buildToolInputSchema({
		serviceType: z
			.string()
			.min(1)
			.optional()
			.describe(
				`mDNS service type to browse. Defaults to ${defaultCastMdnsServiceType}.`,
			),
	})

	registerTool(
		{
			name: 'phone_mdns_scan',
			title: 'Scan mDNS From Android Phone',
			description:
				'Browse LAN mDNS from the connected Android phone. Defaults to Google Cast (_googlecast._tcp). Uses a 60s RPC timeout.',
			inputSchema: mdnsSchema.inputSchema,
			sdkInputSchema: mdnsSchema.sdkInputSchema,
		},
		async (args) => {
			const serviceType =
				args['serviceType'] == null
					? defaultCastMdnsServiceType
					: String(args['serviceType'])
			return await callPhoneTool(
				phone,
				'phone_mdns_scan',
				{ serviceType },
				{ timeoutMs: phoneMdnsScanTimeoutMs },
			)
		},
	)

	const packagesSchema = buildToolInputSchema({
		query: z
			.string()
			.min(1)
			.optional()
			.describe('Optional package name or label filter.'),
	})

	registerTool(
		{
			name: 'phone_packages',
			title: 'List Android Packages',
			description:
				'List installed packages on the connected Android phone, optionally filtered by query.',
			inputSchema: packagesSchema.inputSchema,
			sdkInputSchema: packagesSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
			},
		},
		async (args) => {
			const query = args['query'] == null ? undefined : String(args['query'])
			return await callPhoneTool(
				phone,
				'phone_packages',
				query ? { query } : {},
			)
		},
	)

	const openSettingsSchema = buildToolInputSchema({
		packageName: z
			.string()
			.min(1)
			.describe('Android package name whose Settings page should open.'),
	})

	registerTool(
		{
			name: 'phone_open_app_settings',
			title: 'Open Android App Settings',
			description: `${settingsNotice} Use only when the operator wants the phone to jump into that package’s system settings.`,
			inputSchema: openSettingsSchema.inputSchema,
			sdkInputSchema: openSettingsSchema.sdkInputSchema,
		},
		async (args) =>
			await callPhoneTool(phone, 'phone_open_app_settings', {
				packageName: String(args['packageName'] ?? ''),
			}),
	)

	registerTool(
		{
			name: 'phone_battery',
			title: 'Get Android Battery Status',
			description:
				'Read battery level, charging state, temperature, and unrestricted-battery flag from the connected Android phone.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_battery'),
	)

	registerTool(
		{
			name: 'phone_bluetooth',
			title: 'Get Android Bluetooth Status',
			description:
				'Read whether Bluetooth is present and enabled, plus bonded device names. This does not connect or disconnect devices.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_bluetooth'),
	)

	registerTool(
		{
			name: 'phone_display',
			title: 'Get Android Display Metrics',
			description:
				'Read pixel size, density, and DPI from the connected Android phone.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_display'),
	)

	registerTool(
		{
			name: 'phone_system',
			title: 'Get Android System Toggles',
			description:
				'Read airplane mode, Wi-Fi on/off, location mode, ADB, and private DNS from the connected Android phone. This does not change those toggles.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_system'),
	)

	registerTool(
		{
			name: 'phone_accounts',
			title: 'List Android Accounts',
			description:
				'List signed-in account types and names visible to the Android companion. This does not return passwords or auth tokens.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => await callPhoneTool(phone, 'phone_accounts'),
	)

	const specialSettingsSchema = buildToolInputSchema({
		target: z
			.enum(['app', 'battery', 'notifications'])
			.optional()
			.describe(
				'Settings screen to open. Defaults to this companion app. battery opens unrestricted-battery settings; notifications opens this app’s notification settings.',
			),
	})

	registerTool(
		{
			name: 'phone_open_special_settings',
			title: 'Open Android Special Settings',
			description:
				'Open this companion’s app, battery, or notification Settings screen on the connected phone. Does not launch other apps.',
			inputSchema: specialSettingsSchema.inputSchema,
			sdkInputSchema: specialSettingsSchema.sdkInputSchema,
		},
		async (args) => {
			const target = args['target'] == null ? 'app' : String(args['target'])
			return await callPhoneTool(phone, 'phone_open_special_settings', {
				target,
			})
		},
	)

	registerTool(
		{
			name: 'phone_diagnose_tesla',
			title: 'Diagnose Tesla Android Integration',
			description: `Compose Tesla calendar/contacts debugging from the connected phone: permissions for ${teslaPackageName}, calendars, contacts summary, and network. ${calendarContactsNotice}`,
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => {
			const blocked = phone.getCallReadiness()
			if (blocked) return phoneErrorResult(blocked)
			const [permissions, calendars, contactsSummary, network] =
				await Promise.all([
					phone.call('phone_permissions', {
						packageName: teslaPackageName,
					}),
					phone.call('phone_calendars'),
					phone.call('phone_contacts_summary'),
					phone.call('phone_network'),
				])
			return structuredTextResult(
				'Tesla diagnosis from the connected Android companion.',
				{
					ok: true,
					permissions,
					calendars,
					contactsSummary,
					network,
				},
			)
		},
	)

	registerTool(
		{
			name: 'phone_diagnose_cast',
			title: 'Diagnose Android Cast / Google Home',
			description:
				'Compose home-cast debugging from the connected phone: network, mDNS _googlecast._tcp, and permissions for Google Home, YouTube, and GMS.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
			},
		},
		async () => {
			const blocked = phone.getCallReadiness()
			if (blocked) return phoneErrorResult(blocked)
			const [network, mdns, googleHome, youtube, gms] = await Promise.all([
				phone.call('phone_network'),
				phone.call(
					'phone_mdns_scan',
					{ serviceType: defaultCastMdnsServiceType },
					{ timeoutMs: phoneMdnsScanTimeoutMs },
				),
				phone.call('phone_permissions', {
					packageName: googleHomePackageName,
				}),
				phone.call('phone_permissions', {
					packageName: youtubePackageName,
				}),
				phone.call('phone_permissions', {
					packageName: gmsPackageName,
				}),
			])
			return structuredTextResult(
				'Cast diagnosis from the connected Android companion.',
				{
					ok: true,
					network,
					mdns,
					permissions: {
						[googleHomePackageName]: googleHome,
						[youtubePackageName]: youtube,
						[gmsPackageName]: gms,
					},
				},
			)
		},
	)
}
