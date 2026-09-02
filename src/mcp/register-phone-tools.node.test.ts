import { expect, test } from 'vitest'
import {
	defaultCastMdnsServiceType,
	gmsPackageName,
	googleHomePackageName,
	phoneMdnsScanTimeoutMs,
	teslaPackageName,
	youtubePackageName,
	type createPhoneAdapter,
	type PhoneCallResult,
	type PhoneConnectionStatus,
	type PhoneStructuredError,
} from '../adapters/phone/index.ts'
import { registerPhoneHomeConnectorTools } from './register-phone-tools.ts'

function createFakePhone(input: {
	status?: Partial<PhoneConnectionStatus>
	readiness?: PhoneStructuredError | null
	onCall?: (
		tool: string,
		args: Record<string, unknown>,
		options?: { timeoutMs?: number },
	) => PhoneCallResult | Promise<PhoneCallResult>
}) {
	const calls: Array<{
		tool: string
		args: Record<string, unknown>
		options?: { timeoutMs?: number }
	}> = []
	const phone = {
		getStatus() {
			return {
				tokenConfigured: true,
				connected: false,
				websocketPath: '/phone/ws',
				publicWebSocketUrl: 'wss://kody-home.doddsfamily.us/phone/ws',
				localWebSocketUrl: 'ws://127.0.0.1:4040/phone/ws',
				lastHello: null,
				lastSeenAt: null,
				connectedAt: null,
				deviceId: null,
				...input.status,
			}
		},
		getCallReadiness() {
			return input.readiness === undefined
				? {
						ok: false as const,
						error: {
							code: 'phone_offline',
							message: 'No Android companion is connected.',
						},
					}
				: input.readiness
		},
		async call(
			tool: string,
			args: Record<string, unknown> = {},
			options?: { timeoutMs?: number },
		) {
			calls.push({ tool, args, options })
			if (input.onCall) return await input.onCall(tool, args, options)
			return { ok: true as const, payload: { tool, args } }
		},
	} satisfies Partial<ReturnType<typeof createPhoneAdapter>> as ReturnType<
		typeof createPhoneAdapter
	>
	return { phone, calls }
}

function registerAll(phone: ReturnType<typeof createPhoneAdapter>) {
	const tools = new Map<
		string,
		{
			description: string
			handler: (args: Record<string, unknown>) => Promise<unknown>
		}
	>()
	registerPhoneHomeConnectorTools({
		phone,
		registerTool(descriptor, handler) {
			tools.set(descriptor.name, {
				description: descriptor.description,
				handler,
			})
		},
	})
	return tools
}

test('phone_status reports offline without throwing', async () => {
	const { phone } = createFakePhone({
		status: { connected: false, tokenConfigured: true },
		readiness: {
			ok: false,
			error: {
				code: 'phone_offline',
				message: 'No Android companion is connected.',
			},
		},
	})
	const tools = registerAll(phone)
	const result = await tools.get('phone_status')?.handler({})
	expect(result).toMatchObject({
		structuredContent: {
			ok: true,
			connected: false,
			tokenConfigured: true,
		},
	})
	expect(result).not.toMatchObject({ isError: true })
})

test('phone RPC tools return the phone_offline structured error', async () => {
	const { phone } = createFakePhone({})
	const tools = registerAll(phone)
	const result = await tools.get('phone_network')?.handler({})
	expect(result).toMatchObject({
		isError: true,
		content: [
			{
				type: 'text',
				text: 'No Android companion is connected.',
			},
		],
		structuredContent: {
			ok: false,
			error: {
				code: 'phone_offline',
				message: 'No Android companion is connected.',
			},
		},
	})
})

test('phone_diagnose_tesla and phone_diagnose_cast compose fan-out RPCs', async () => {
	const { phone, calls } = createFakePhone({
		readiness: null,
		onCall: async (tool, args) => ({
			ok: true,
			payload: { tool, args },
		}),
	})
	const tools = registerAll(phone)

	const tesla = await tools.get('phone_diagnose_tesla')?.handler({})
	expect(tesla).toMatchObject({
		structuredContent: {
			ok: true,
			permissions: {
				ok: true,
				payload: {
					tool: 'phone_permissions',
					args: { packageName: teslaPackageName },
				},
			},
			calendars: { ok: true, payload: { tool: 'phone_calendars' } },
			contactsSummary: {
				ok: true,
				payload: { tool: 'phone_contacts_summary' },
			},
			network: { ok: true, payload: { tool: 'phone_network' } },
		},
	})
	expect(calls.map((call) => call.tool)).toEqual([
		'phone_permissions',
		'phone_calendars',
		'phone_contacts_summary',
		'phone_network',
	])

	calls.length = 0
	const cast = await tools.get('phone_diagnose_cast')?.handler({})
	expect(cast).toMatchObject({
		structuredContent: {
			ok: true,
			network: { ok: true, payload: { tool: 'phone_network' } },
			mdns: {
				ok: true,
				payload: {
					tool: 'phone_mdns_scan',
					args: { serviceType: defaultCastMdnsServiceType },
				},
			},
			permissions: {
				[googleHomePackageName]: {
					ok: true,
					payload: {
						tool: 'phone_permissions',
						args: { packageName: googleHomePackageName },
					},
				},
				[youtubePackageName]: {
					ok: true,
					payload: {
						tool: 'phone_permissions',
						args: { packageName: youtubePackageName },
					},
				},
				[gmsPackageName]: {
					ok: true,
					payload: {
						tool: 'phone_permissions',
						args: { packageName: gmsPackageName },
					},
				},
			},
		},
	})
	expect(
		calls.find((call) => call.tool === 'phone_mdns_scan')?.options,
	).toEqual({ timeoutMs: phoneMdnsScanTimeoutMs })
})

test('phone tool descriptions mention calendar, contacts, and settings blast radius', () => {
	const { phone } = createFakePhone({ readiness: null })
	const tools = registerAll(phone)
	expect(tools.get('phone_calendars')?.description).toMatch(/calendar/i)
	expect(tools.get('phone_contacts_summary')?.description).toMatch(/contact/i)
	expect(tools.get('phone_open_app_settings')?.description).toMatch(/Settings/)
})
