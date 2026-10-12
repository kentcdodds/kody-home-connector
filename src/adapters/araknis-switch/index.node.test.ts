import { expect, test, vi } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import {
	araknisDot1dBaseConfig,
	araknisInterfacesPayload,
	araknisLldpCliSample,
	araknisLoginSuccess,
	araknisVlan20Payload,
	araknisVlansPayload,
} from './fixtures.ts'
import { createAraknisSwitchOpenClient } from './client.ts'
import { createAraknisSwitchAdapter } from './index.ts'
import { parseLldpRemoteDeviceCli } from './parsing.ts'

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

function createConfig(extra: Record<string, string | undefined> = {}) {
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
		ARAKNIS_SWITCH_SSH_ENABLED: 'false',
		...extra,
	})
	return loadHomeConnectorConfig()
}

function installOpenFetchMock() {
	return vi.fn(async (url: string | URL) => {
		const href = String(url)
		if (href.endsWith('/open/v1/login')) {
			return Response.json(araknisLoginSuccess, {
				headers: {
					'set-cookie': 'SIDSSL=test-session-id-not-a-secret; Path=/',
				},
			})
		}
		if (href.includes('/open/v1/dot1dbaseconfig')) {
			return Response.json(araknisDot1dBaseConfig)
		}
		if (href.includes('/open/v1/vlans?id=20')) {
			return Response.json(araknisVlan20Payload)
		}
		if (href.includes('/open/v1/vlans')) {
			return Response.json(araknisVlansPayload)
		}
		if (href.includes('/open/v1/interfaces')) {
			return Response.json(araknisInterfacesPayload)
		}
		if (href.includes('/open/v1/lldp')) {
			return new Response('not found', { status: 404 })
		}
		if (href.endsWith('/open/v1/logout')) {
			return new Response(null, { status: 200 })
		}
		throw new Error(`Unexpected URL ${href}`)
	})
}

test('adapter status and VLAN membership tools never echo credentials', async () => {
	const fetchMock = installOpenFetchMock()
	const config = createConfig()
	const adapter = createAraknisSwitchAdapter({
		config,
		clientFactory: () =>
			createAraknisSwitchOpenClient({
				config,
				fetchImpl: fetchMock as typeof fetch,
			}),
	})

	const status = await adapter.getStatus()
	const membership = await adapter.getVlanMembership(20)
	const ports = await adapter.listPorts()

	expect(status.connected).toBe(true)
	expect(status.vlanCount).toBe(3)
	expect(status.portCount).toBe(9)
	expect(status.config.hasUsername).toBe(true)
	expect(status.config.hasPassword).toBe(true)
	expect(JSON.stringify(status)).not.toContain('test-password')
	expect(JSON.stringify(status)).not.toContain('araknis')
	expect(membership.taggedPorts).toContain('0/5')
	expect(membership.taggedPorts).toContain('0/24')
	expect(
		ports.find((port) => port.description === 'Island-uplink'),
	).toBeTruthy()
	expect(JSON.stringify(membership)).not.toContain('test-password')
})

test('adapter falls back to SSH LLDP when enabled and OpEN LLDP is empty', async () => {
	const fetchMock = installOpenFetchMock()
	const config = createConfig({ ARAKNIS_SWITCH_SSH_ENABLED: 'true' })
	const adapter = createAraknisSwitchAdapter({
		config,
		clientFactory: () =>
			createAraknisSwitchOpenClient({
				config,
				fetchImpl: fetchMock as typeof fetch,
			}),
		sshLldpFetcher: async () => parseLldpRemoteDeviceCli(araknisLldpCliSample),
	})

	const lldp = await adapter.listLldpNeighbors()
	expect(lldp.source).toBe('ssh-cli')
	expect(lldp.neighbors.map((neighbor) => neighbor.remoteSystemName)).toEqual([
		'RuckusAP-1',
		'Island',
	])
	expect(JSON.stringify(lldp)).not.toContain('test-password')
})

test('adapter reports missing credentials without attempting login', async () => {
	const adapter = createAraknisSwitchAdapter({
		config: createConfig({
			ARAKNIS_SWITCH_USERNAME: undefined,
			ARAKNIS_SWITCH_PASSWORD: undefined,
		}),
	})
	const status = await adapter.getStatus()
	expect(status.connected).toBe(false)
	expect(status.config.missingFields).toEqual([
		'ARAKNIS_SWITCH_USERNAME',
		'ARAKNIS_SWITCH_PASSWORD',
	])
})
