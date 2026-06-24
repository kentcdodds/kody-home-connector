import { expect, test } from 'vitest'
import { upsertKasaDiscoveredPlugByStableIdentity } from './discovery.ts'
import { type KasaDiscoveredPlug } from './types.ts'

function createPlug(
	overrides: Partial<KasaDiscoveredPlug> = {},
): KasaDiscoveredPlug {
	return {
		plugId: 'host:192.168.1.145',
		alias: 'Kasa plug 192.168.1.145',
		host: '192.168.1.145',
		port: 80,
		model: null,
		mac: null,
		deviceId: null,
		relayState: 'unknown',
		rawSysinfo: null,
		rawDiscovery: null,
		lastSeenAt: '2026-06-24T18:05:00.000Z',
		...overrides,
	}
}

test('discovery replaces host fallback identity with stable KLAP identity for the same plug', () => {
	const plugs = new Map<string, KasaDiscoveredPlug>()
	upsertKasaDiscoveredPlugByStableIdentity(plugs, createPlug())
	upsertKasaDiscoveredPlugByStableIdentity(
		plugs,
		createPlug({
			plugId: 'device-1',
			alias: 'Water recirculating pump',
			deviceId: 'device-1',
			rawSysinfo: {
				alias: 'Water recirculating pump',
				device_id: 'device-1',
			},
		}),
	)

	expect([...plugs.keys()]).toEqual(['device-1'])
	expect(plugs.get('device-1')).toMatchObject({
		alias: 'Water recirculating pump',
		host: '192.168.1.145',
	})

	upsertKasaDiscoveredPlugByStableIdentity(
		plugs,
		createPlug({
			alias: 'Late UDP fallback',
		}),
	)
	expect([...plugs.keys()]).toEqual(['device-1'])
})
