import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createKasaAdapter } from './index.ts'
import {
	type KasaClient,
	type KasaRelayState,
	type KasaSysInfo,
} from './types.ts'

function createConfig() {
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	process.env.KASA_SCAN_CIDRS = '192.168.10.70/32'
	process.env.KASA_REQUEST_TIMEOUT_MS = '1500'
	return loadHomeConnectorConfig()
}

function createFakeKasaClient() {
	let relayState: KasaRelayState = 1
	let failNextStatusRead = false
	const calls: Array<{ command: string; state?: KasaRelayState }> = []
	const sysInfo = (): KasaSysInfo => ({
		err_code: 0,
		alias: 'Office Lamp',
		model: 'HS103(US)',
		deviceId: '800612345678',
		mac: 'AA-BB-CC-DD-EE-FF',
		hwId: 'hardware-id',
		sw_ver: '1.1.0',
		relay_state: relayState,
		led_off: 0,
		on_time: relayState === 1 ? 42 : 0,
	})
	const client: KasaClient = {
		async getSysInfo() {
			calls.push({ command: 'getSysInfo' })
			if (failNextStatusRead) {
				failNextStatusRead = false
				throw new Error('simulated status read failure')
			}
			return sysInfo()
		},
		async setRelayState(input) {
			calls.push({ command: 'setRelayState', state: input.state })
			relayState = input.state
			return { err_code: 0 }
		},
	}
	return {
		client,
		calls,
		sysInfo,
		failNextStatusRead() {
			failNextStatusRead = true
		},
	}
}

test('Kasa adapter scans, adopts, reads status, and controls adopted plugs', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const fake = createFakeKasaClient()
	const kasa = createKasaAdapter({
		config,
		state,
		storage,
		client: fake.client,
		scanPlugs: async () => ({
			plugs: [
				{
					plugId: 'kasa-plug-800612345678',
					alias: 'Office Lamp',
					host: '192.168.10.70',
					port: 9999,
					model: 'HS103(US)',
					macAddress: 'aa:bb:cc:dd:ee:ff',
					deviceId: '800612345678',
					hwId: 'hardware-id',
					swVer: '1.1.0',
					relayState: 1,
					ledOff: 0,
					onTime: 42,
					lastSeenAt: '2026-06-24T14:00:00.000Z',
					rawSysInfo: fake.sysInfo(),
				},
			],
			diagnostics: {
				protocol: 'subnet',
				discoveryUrl: '192.168.10.70/32',
				scannedAt: '2026-06-24T14:00:00.000Z',
				probes: [
					{
						host: '192.168.10.70',
						port: 9999,
						matched: true,
						plugId: 'kasa-plug-800612345678',
						alias: 'Office Lamp',
						model: 'HS103(US)',
						error: null,
					},
				],
				subnetProbe: {
					cidrs: ['192.168.10.70/32'],
					hostsProbed: 1,
					plugMatches: 1,
				},
			},
		}),
	})

	try {
		const scanned = await kasa.scan()
		expect(scanned).toMatchObject([
			{
				plugId: 'kasa-plug-800612345678',
				alias: 'Office Lamp',
				adopted: false,
				relayState: 1,
			},
		])
		await expect(kasa.turnPlugOff('Office Lamp')).rejects.toThrow(
			'must be adopted',
		)

		expect(kasa.adoptPlug('kasa-plug-800612345678')).toMatchObject({
			plugId: 'kasa-plug-800612345678',
			adopted: true,
		})
		await expect(kasa.getPlugStatus('office')).resolves.toMatchObject({
			plug: {
				alias: 'Office Lamp',
				relayState: 1,
			},
			online: true,
		})
		await expect(kasa.turnPlugOff('Office Lamp')).resolves.toMatchObject({
			requestedState: 0,
			plug: {
				relayState: 0,
			},
			confirmed: true,
		})
		expect(fake.calls).toContainEqual({ command: 'setRelayState', state: 0 })

		fake.failNextStatusRead()
		await expect(kasa.turnPlugOn('Office Lamp')).resolves.toMatchObject({
			requestedState: 1,
			plug: {
				relayState: 1,
				lastError: expect.stringContaining('follow-up status read failed'),
			},
			status: null,
			confirmed: false,
			statusReadError: expect.stringContaining('simulated status read failure'),
		})
		expect(kasa.listPlugs()).toMatchObject([
			expect.objectContaining({
				plugId: 'kasa-plug-800612345678',
				relayState: 1,
				lastError: expect.stringContaining('follow-up status read failed'),
			}),
		])
		expect(fake.calls).toContainEqual({ command: 'setRelayState', state: 1 })
	} finally {
		storage.close()
	}
})
