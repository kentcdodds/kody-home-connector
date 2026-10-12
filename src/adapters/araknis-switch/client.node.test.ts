import { expect, test, vi } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAraknisSwitchOpenClient } from './client.ts'
import {
	araknisDot1dBaseConfig,
	araknisInterfacesPayload,
	araknisLoginSuccess,
	araknisVlan20Payload,
	araknisVlansPayload,
} from './fixtures.ts'

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
		HOME_CONNECTOR_DB_PATH: ':memory:',
		ARAKNIS_SWITCH_BASE_URL: 'https://192.168.0.50',
		ARAKNIS_SWITCH_USERNAME: 'araknis',
		ARAKNIS_SWITCH_PASSWORD: 'test-password',
		ARAKNIS_SWITCH_ALLOW_INSECURE_TLS: 'true',
	})
	return loadHomeConnectorConfig()
}

test('OpEN client logs in with SIDSSL cookie and reads VLANs/interfaces', async () => {
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (href.endsWith('/open/v1/login')) {
			expect(String(init?.body)).toContain('username=araknis')
			expect(String(init?.body)).toContain('password=test-password')
			return new Response(JSON.stringify(araknisLoginSuccess), {
				status: 200,
				headers: {
					'content-type': 'application/json',
					'set-cookie': 'SIDSSL=test-session-id-not-a-secret; Path=/',
				},
			})
		}
		expect(new Headers(init?.headers).get('cookie')).toContain(
			'SIDSSL=test-session-id-not-a-secret',
		)
		if (href.includes('/open/v1/vlans?id=20')) {
			return Response.json(araknisVlan20Payload)
		}
		if (href.includes('/open/v1/vlans')) {
			return Response.json(araknisVlansPayload)
		}
		if (href.includes('/open/v1/interfaces')) {
			return Response.json(araknisInterfacesPayload)
		}
		if (href.includes('/open/v1/dot1dbaseconfig')) {
			return Response.json(araknisDot1dBaseConfig)
		}
		if (href.includes('/open/v1/lldp')) {
			return new Response('not found', { status: 404 })
		}
		if (href.endsWith('/open/v1/logout')) {
			return new Response(null, { status: 200 })
		}
		throw new Error(`Unexpected URL ${href}`)
	})

	const client = createAraknisSwitchOpenClient({
		config: createConfig(),
		fetchImpl: fetchMock as typeof fetch,
	})

	await client.login()
	const vlans = await client.listVlans()
	const interfaces = await client.listInterfaces()
	const vlan20 = await client.getVlan(20)
	const lldp = await client.listLldpNeighbors()
	await client.logout()

	expect(vlans.map((vlan) => vlan.id)).toEqual([1, 20, 30])
	expect(interfaces).toHaveLength(9)
	expect(vlan20.vlan).toMatchObject({ id: 20, name: 'AP' })
	expect(vlan20.members).toHaveLength(3)
	expect(lldp).toEqual([])
	const logoutCall = fetchMock.mock.calls.find(([url]) =>
		String(url).endsWith('/open/v1/logout'),
	)
	expect(JSON.stringify(logoutCall?.[1]?.headers ?? {})).not.toContain(
		'test-password',
	)
})
