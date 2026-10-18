import { expect, test, vi } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { AccessNetworksUnleashedAuthError } from './errors.ts'
import { readFileSync } from 'node:fs'
import {
	accessNetworksUnleashedDangerousListSetconfConfirmation,
	accessNetworksUnleashedRequestConfirmation,
	accessNetworksUnleashedWlanWriteConfirmation,
	createAccessNetworksUnleashedAdapter,
} from './index.ts'

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

function createConfig() {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		HOME_CONNECTOR_ID: 'default',
		HOME_CONNECTOR_SHARED_SECRET: 'home-connector-secret-home-connector-secret',
		WORKER_BASE_URL: 'http://localhost:3742',
		ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.10.60/32',
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'true',
		HOME_CONNECTOR_DB_PATH: ':memory:',
	})
	return loadHomeConnectorConfig()
}

function response(
	body: string | null,
	init: ResponseInit & { url?: string } = {},
) {
	const output = new Response(body, init)
	Object.defineProperty(output, 'url', {
		value: init.url ?? 'https://192.168.10.60/admin/wsg',
	})
	return output
}

const validReason =
	'Operator needs raw AJAX access to verify a configuration change is correct.'

function installLoginAndCmdstat(handler: (body: string) => Response) {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (href === 'https://192.168.10.60/' || href === 'https://192.168.10.60') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://192.168.10.60/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				headers: {
					'set-cookie': 'JSESSIONID=abc; Path=/admin; HttpOnly',
				},
				url: 'https://192.168.10.60/admin/wsg/login.jsp',
			})
		}
		if (
			(init?.method === 'POST' || init?.method === 'post') &&
			href.endsWith('/login.jsp') &&
			String(init?.body ?? '').includes('username=admin')
		) {
			return response(null, {
				status: 302,
				headers: {
					Location: '/admin/wsg/',
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return handler(String(init?.body ?? ''))
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch
	return {
		fetchMock,
		[Symbol.dispose]: () => {
			globalThis.fetch = previousFetch
		},
	}
}

test('adapter exposes scan, adopt, set-credentials, authenticate, and request workflow', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})
	using _server = installLoginAndCmdstat(() =>
		response(
			'<ajax-response><system name="Access Networks Unleashed" version="200.15.6.212"/></ajax-response>',
		),
	)

	try {
		expect(await adapter.getConfigStatus()).toMatchObject({
			configured: false,
			missingRequirements: ['controller', 'credentials'],
		})

		const scanned = await adapter.scan()
		expect(scanned).toHaveLength(1)
		expect(scanned[0]).toMatchObject({
			controllerId: '192.168.10.60',
			adopted: false,
			hasStoredCredentials: false,
		})

		const adopted = await adapter.adoptController({
			controllerId: '192.168.10.60',
		})
		expect(adopted).toMatchObject({
			controllerId: '192.168.10.60',
			adopted: true,
		})

		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		const authenticated = await adapter.authenticate()
		expect(authenticated.lastAuthenticatedAt).toEqual(expect.any(String))
		expect(authenticated.lastAuthError).toBeNull()

		const result = await adapter.request({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<sysinfo/>',
			acknowledgeHighRisk: true,
			reason: validReason,
			confirmation: accessNetworksUnleashedRequestConfirmation,
		})
		expect(result.action).toBe('getstat')
		expect(result.parsed).toMatchObject({
			'ajax-response': {
				system: { '@name': 'Access Networks Unleashed' },
			},
		})

		const adoptedController = await adapter.getAdoptedController()
		expect(adoptedController?.lastAuthenticatedAt).toEqual(expect.any(String))
		expect(adoptedController?.lastAuthError).toBeNull()
	} finally {
		await storage.close()
	}
})

test('request rejects without acknowledgement, confirmation, or sufficient reason', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new Error('client should not be invoked when validation fails')
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)

	try {
		await adapter.scan()
		await adapter.adoptController({ controllerId: '192.168.10.60' })
		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: false,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('acknowledgeHighRisk')

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: 'too short',
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('at least 20 characters')

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: 'something else',
			}),
		).rejects.toThrow('confirmation must exactly equal')
	} finally {
		await storage.close()
	}
})

test('request refuses whole-list WLAN setconf payloads', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new Error(
					'client should not be invoked for whole-list WLAN writes',
				)
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)

	try {
		await adapter.scan()
		await adapter.adoptController({ controllerId: '192.168.10.60' })
		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				action: 'setconf',
				comp: 'wlansvc-list',
				xmlBody:
					"<wlansvc id='1' name='friendlyfamily'/><wlansvc id='5' name='friendlyguest' vlan-id='20'/>",
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow(/whole WLAN list|list component|update_wlan|clone_wlan/i)

		await expect(
			adapter.request({
				action: 'setconf',
				comp: 'wlansvc-list',
				xmlBody:
					"<wlansvc id='5' name='friendlyguest' ssid='friendlyguest' vlan-id='20'></wlansvc>",
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow(/positional|update_wlan/i)
	} finally {
		await storage.close()
	}
})

test('request rejects unknown actions and empty comp', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new Error('client should not be invoked when validation fails')
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)

	try {
		await adapter.scan()
		await adapter.adoptController({ controllerId: '192.168.10.60' })
		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				// @ts-expect-error: invalid action by design
				action: 'delete',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('action must be one of')

		await expect(
			adapter.request({
				action: 'getstat',
				comp: '   ',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('comp must not be empty')
	} finally {
		await storage.close()
	}
})

test('request requires an adopted controller with stored credentials', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})

	try {
		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('No Access Networks Unleashed controller is adopted')
	} finally {
		await storage.close()
	}
})

test('request preserves last successful authentication on transient failure', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})
	let shouldFail = false
	using _server = installLoginAndCmdstat(() => {
		if (shouldFail) {
			throw new Error('temporary network outage')
		}
		return response(
			'<ajax-response><system name="Access Networks Unleashed"/></ajax-response>',
		)
	})

	try {
		await adapter.scan()
		await adapter.adoptController({ controllerId: '192.168.10.60' })
		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		const authenticated = await adapter.authenticate()
		const lastAuthenticatedAt = authenticated.lastAuthenticatedAt

		shouldFail = true
		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('temporary network outage')

		// A non-auth transport error must not be recorded as an authentication
		// failure; the previous successful auth state is kept intact so the next
		// retry does not look like the controller has bad credentials.
		const adopted = await adapter.getAdoptedController()
		expect(adopted?.lastAuthenticatedAt).toBe(lastAuthenticatedAt)
		expect(adopted?.lastAuthError).toBeNull()
	} finally {
		await storage.close()
	}
})

test('request records lastAuthError when the underlying call is an auth failure', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new AccessNetworksUnleashedAuthError(
					'Access Networks Unleashed authentication failed: login was rejected.',
				)
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response(
			'<ajax-response><system name="Access Networks Unleashed"/></ajax-response>',
		),
	)

	try {
		await adapter.scan()
		await adapter.adoptController({ controllerId: '192.168.10.60' })
		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('login was rejected')

		const adopted = await adapter.getAdoptedController()
		expect(adopted?.lastAuthError).toMatch(/login was rejected/)
	} finally {
		await storage.close()
	}
})

test('request does not record lastAuthError for command rejection text', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})
	let cmdstatCalls = 0
	using _server = installLoginAndCmdstat(() => {
		cmdstatCalls += 1
		if (cmdstatCalls === 1) {
			return response(
				'<ajax-response><system name="Access Networks Unleashed"/></ajax-response>',
			)
		}
		return response(
			'<ajax-response><xmsg error="1" lmsg="authentication failed for remote user"/></ajax-response>',
		)
	})

	try {
		await adapter.scan()
		await adapter.adoptController({ controllerId: '192.168.10.60' })
		await adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})
		await adapter.authenticate('192.168.10.60')
		const afterAuth = await adapter.getAdoptedController()
		expect(afterAuth?.lastAuthenticatedAt).toBeTruthy()
		expect(afterAuth?.lastAuthError).toBeNull()

		await expect(
			adapter.request({
				action: 'docmd',
				comp: 'stamgr',
				xmlBody: "<xcmd cmd='reset'/>",
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('rejected the command')

		const adopted = await adapter.getAdoptedController()
		expect(adopted?.lastAuthenticatedAt).toBe(afterAuth?.lastAuthenticatedAt)
		expect(adopted?.lastAuthError).toBeNull()
	} finally {
		await storage.close()
	}
})

async function createAdoptedAdapterWithClient(
	request: (input: {
		action: string
		comp: string
		xmlBody: string
		decryptSecrets?: boolean
	}) => Promise<string>,
) {
	const config = createConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	const calls: Array<{
		action: string
		comp: string
		xmlBody: string
		decryptSecrets?: boolean
	}> = []
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request(input) {
				calls.push({
					action: input.action,
					comp: input.comp,
					xmlBody: input.xmlBody,
					decryptSecrets: input.decryptSecrets,
				})
				const xml = await request(input)
				return {
					action: input.action,
					comp: input.comp,
					updater: 'test',
					xml,
					parsed: null,
				}
			},
		}),
	})
	return { adapter, storage, calls }
}

async function adopt(
	adapter: ReturnType<typeof createAccessNetworksUnleashedAdapter>,
) {
	await adapter.scan()
	await adapter.adoptController({ controllerId: '192.168.10.60' })
	await adapter.setCredentials({
		controllerId: '192.168.10.60',
		username: 'admin',
		password: 'secret-password',
	})
}

test('raw request refuses any single-<wlansvc> setconf, including IS_PARTIAL with an id', async () => {
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async () => '<ajax-response/>',
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	try {
		await adopt(adapter)
		for (const xmlBody of [
			"<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>",
			"<wlansvc name='friendlyguest-2.4' ssid='friendlyguest-2.4'/>",
		]) {
			await expect(
				adapter.request({
					action: 'setconf',
					comp: 'wlansvc-list',
					xmlBody,
					acknowledgeHighRisk: true,
					reason: validReason,
					confirmation: accessNetworksUnleashedRequestConfirmation,
				}),
			).rejects.toThrow(
				/positional \(it targets the first entry whatever id you send\)/,
			)
		}
		expect(calls).toEqual([])
	} finally {
		await storage.close()
	}
})

test('raw request redacts WLAN secrets in the returned xml and parsed object', async () => {
	const { adapter, storage } = await createAdoptedAdapterWithClient(
		async () =>
			"<ajax-response><wlansvc-list><wlansvc id='1' name='a' guest-pass='GP-SECRET'><wpa cipher='aes' x-passphrase='X-SECRET' passphrase='PSK-SECRET'/></wlansvc></wlansvc-list></ajax-response>",
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	try {
		await adopt(adapter)
		const result = await adapter.request({
			action: 'getconf',
			comp: 'wlansvc-list',
			xmlBody: '',
			acknowledgeHighRisk: true,
			reason: validReason,
			confirmation: accessNetworksUnleashedRequestConfirmation,
		})
		expect(result.xml).not.toMatch(/GP-SECRET|X-SECRET|PSK-SECRET/)
		expect(JSON.stringify(result.parsed)).not.toMatch(
			/GP-SECRET|X-SECRET|PSK-SECRET/,
		)
		expect(result.xml).toContain("name='a'")
	} finally {
		await storage.close()
	}
})

test('list_wlans works on the damaged Oct 17 list and reports the id-less entry', async () => {
	const damaged = readFileSync(
		new URL(
			'./fixtures/wlansvc-list-after-clone-incident.xml',
			import.meta.url,
		),
		'utf8',
	)
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async () => damaged,
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	try {
		await adopt(adapter)
		const list = await adapter.listWlans()
		expect(list.wlans.map((wlan) => wlan.id)).toEqual(['2', '3', '5'])
		expect(list.damaged).toBe(true)
		expect(list.anomalies).toEqual([
			{
				index: 0,
				kind: 'missing-id',
				name: 'friendlyguest-2.4',
				ssid: 'friendlyguest-2.4',
			},
		])
		expect(list.wlanCount).toBe(4)
		const one = await adapter.getWlan({ id: '5' })
		expect(one.wlan.name).toBe('friendlyguest')
		// Read tools never ask the controller to decrypt secrets.
		expect(calls.every((call) => call.decryptSecrets !== true)).toBe(true)
	} finally {
		await storage.close()
	}
})

test('WLAN write tools refuse immediately while wlanWritesEnabled is off (default)', async () => {
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async () => '<ajax-response/>',
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	const write = {
		acknowledgeHighRisk: true,
		reason: validReason,
		confirmation: accessNetworksUnleashedWlanWriteConfirmation,
	}
	try {
		await adopt(adapter)
		await expect(
			adapter.updateWlan({
				id: '5',
				attributes: { 'vlan-id': '20' },
				...write,
			}),
		).rejects.toThrow(/WLAN writes are disabled/)
		await expect(
			adapter.cloneWlan({
				sourceId: '5',
				overrides: { name: 'n', ssid: 'n' },
				...write,
			}),
		).rejects.toThrow(/WLAN writes are disabled/)
		await expect(
			adapter.deleteWlan({ id: '5', expectedName: 'friendlyguest', ...write }),
		).rejects.toThrow(/WLAN writes are disabled/)
		await expect(
			adapter.request({
				action: 'addobj',
				comp: 'wlansvc-list',
				xmlBody: "<wlansvc name='t' ssid='t'/>",
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow(/WLAN writes are disabled/)
		// Not even a snapshot read was sent.
		expect(calls).toEqual([])
	} finally {
		await storage.close()
	}
})

test('raw object actions: setconf on any *-list is refused; delobj on a non-WLAN list is passed through', async () => {
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async () =>
			'<ajax-response><response type="object" id="acl-list.1"/></ajax-response>',
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	const raw = {
		acknowledgeHighRisk: true,
		reason: validReason,
		confirmation: accessNetworksUnleashedRequestConfirmation,
	}
	try {
		await adopt(adapter)
		await expect(
			adapter.request({
				action: 'setconf',
				comp: 'acl-list',
				xmlBody: "<acl id='2' IS_PARTIAL='true'/>",
				...raw,
			}),
		).rejects.toThrow(/list component "acl-list"/)
		await expect(
			adapter.request({
				action: 'setconf',
				comp: 'acl-list',
				xmlBody: "<acl id='2' IS_PARTIAL='true'/>",
				...raw,
				allowDangerousPositionalListSetconf: true,
				dangerousListSetconfConfirmation: 'wrong phrase',
			}),
		).rejects.toThrow(/Escape hatch/)
		await adapter.request({
			action: 'setconf',
			comp: 'acl-list',
			xmlBody: "<acl id='2' IS_PARTIAL='true'/>",
			...raw,
			allowDangerousPositionalListSetconf: true,
			dangerousListSetconfConfirmation:
				accessNetworksUnleashedDangerousListSetconfConfirmation,
		})
		await adapter.request({
			action: 'delobj',
			comp: 'acl-list',
			xmlBody: "<acl id='2'/>",
			...raw,
		})
		expect(calls.map((call) => [call.action, call.comp])).toEqual([
			['setconf', 'acl-list'],
			['delobj', 'acl-list'],
		])
	} finally {
		await storage.close()
	}
})

test('wlansvc-list setconf escape hatch still requires wlanWritesEnabled', async () => {
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async () => '<ajax-response/>',
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	try {
		await adopt(adapter)
		await expect(
			adapter.request({
				action: 'setconf',
				comp: 'wlansvc-list',
				xmlBody: "<wlansvc id='5' IS_PARTIAL='true' vlan-id='20'/>",
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
				allowDangerousPositionalListSetconf: true,
				dangerousListSetconfConfirmation:
					accessNetworksUnleashedDangerousListSetconfConfirmation,
			}),
		).rejects.toThrow(/WLAN writes are disabled/)
		expect(calls).toEqual([])
	} finally {
		await storage.close()
	}
})

test('dryRun clone works while wlanWritesEnabled is off and sends nothing', async () => {
	const beforeXml = readFileSync(
		new URL(
			'./fixtures/wlansvc-list-before-clone-incident.xml',
			import.meta.url,
		),
		'utf8',
	)
	const templateXml = readFileSync(
		new URL('./fixtures/wlansvc-standard-template.xml', import.meta.url),
		'utf8',
	)
	const guestserviceXml = readFileSync(
		new URL('./fixtures/guestservice-list.xml', import.meta.url),
		'utf8',
	)
	const hydrateDecrypt = (xml: string) =>
		xml.replace(
			/<wpa cipher="aes"/g,
			'<wpa cipher="aes" x-passphrase="TEST-ONLY-psk" passphrase="TEST-ONLY-psk"',
		)
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async (input) => {
			if (input.comp === 'wlansvc-standard-template') {
				return input.decryptSecrets ? hydrateDecrypt(templateXml) : templateXml
			}
			if (input.comp === 'guestservice-list') return guestserviceXml
			return input.decryptSecrets ? hydrateDecrypt(beforeXml) : beforeXml
		},
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	try {
		await adopt(adapter)
		const result = await adapter.cloneWlan({
			sourceId: '5',
			overrides: {
				name: 'friendlyguest-2.4',
				ssid: 'friendlyguest-2.4',
				radioBand: '2.4ghz',
			},
			dryRun: true,
			acknowledgeHighRisk: false,
			reason: '',
			confirmation: '',
		})
		expect(result.dryRun).toBe(true)
		expect(result.requests).toHaveLength(2)
		expect(result.requests[0]?.action).toBe('addobj')
		expect(result.requests[0]?.comp).toBe('guestservice-list')
		expect(result.requests[1]?.action).toBe('addobj')
		expect(result.requests[1]?.comp).toBe('wlansvc-list')
		expect(result.requestXml).not.toMatch(/\sid\s*=/)
		expect(result.requestXml).not.toMatch(/TEST-ONLY/)
		expect(calls.every((call) => call.action === 'getconf')).toBe(true)
		expect(calls.some((call) => call.action !== 'getconf')).toBe(false)
	} finally {
		await storage.close()
	}
})

test('with wlanWritesEnabled, raw wlansvc-list object writes still need an explicit id', async () => {
	using _env = createTemporaryEnv({
		ACCESS_NETWORKS_UNLEASHED_WLAN_WRITES_ENABLED: 'true',
	})
	const { adapter, storage, calls } = await createAdoptedAdapterWithClient(
		async () => '<ajax-response/>',
	)
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)
	try {
		await adopt(adapter)
		await expect(
			adapter.request({
				action: 'updobj',
				comp: 'wlansvc-list',
				xmlBody: "<wlansvc IS_PARTIAL='true' vlan-id='20'/>",
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow(/explicit wlansvc id/)
		expect(calls).toEqual([])
	} finally {
		await storage.close()
	}
})
