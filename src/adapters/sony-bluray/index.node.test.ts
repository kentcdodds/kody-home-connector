import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import {
	encodeSonyIrccBd1Code,
	getSonyIrccCode,
	sonyIrccTvCodes,
} from './commands.ts'
import { createSonyBlurayAdapter } from './index.ts'
import {
	mockSonyActionListXml,
	mockSonyBlurayHost,
	mockSonyBlurayHostB,
	mockSonyBlurayMac,
	mockSonyCameraXml,
	mockSonyDmrXml,
	mockSonyIrccSoapOk,
	mockSonyIrccXml,
} from './fixtures.ts'
import {
	courtBlurayPlayerId,
	courtSonyCameraNotThePlayer,
	type SonyIrccHttpClient,
} from './types.ts'

function unreachableHttp(): SonyIrccHttpClient {
	return async (input) => {
		throw new Error(`connect EHOSTUNREACH ${input.url}`)
	}
}

function fixtureHttp(input: {
	host?: string
	hosts?: Array<string>
	failControl?: boolean
	postedBodies?: Array<string>
	postedHeaders?: Array<Record<string, string> | undefined>
}): SonyIrccHttpClient {
	const hosts = input.hosts ?? [input.host ?? mockSonyBlurayHost]
	return async (request) => {
		if (request.url.includes(courtSonyCameraNotThePlayer.host)) {
			throw new Error(`connect ECONNREFUSED ${request.url}`)
		}
		if (request.method === 'POST' && request.url.includes('IRCC')) {
			input.postedBodies?.push(request.body ?? '')
			input.postedHeaders?.push(request.headers)
			if (input.failControl) {
				throw new Error(`connect EHOSTUNREACH ${request.url}`)
			}
			expect(request.body ?? '').toContain('<IRCCCode>')
			expect(request.headers?.['SOAPACTION']).toContain('X_SendIRCC')
			return { status: 200, headers: {}, body: mockSonyIrccSoapOk }
		}
		const host = hosts.find((candidate) =>
			request.url.startsWith(`http://${candidate}:`),
		)
		if (!host) {
			throw new Error(`connect EHOSTUNREACH ${request.url}`)
		}
		if (request.url === `http://${host}:50001/Ircc.xml`) {
			return { status: 200, headers: {}, body: mockSonyIrccXml }
		}
		if (request.url === `http://${host}:50002/actionList`) {
			return { status: 200, headers: {}, body: mockSonyActionListXml }
		}
		if (request.url === `http://${host}:52323/dmr.xml`) {
			return { status: 200, headers: {}, body: mockSonyDmrXml }
		}
		throw new Error(`connect EHOSTUNREACH ${request.url}`)
	}
}

function cameraHttp(): SonyIrccHttpClient {
	return async (request) => {
		if (
			request.url.includes('/Ircc.xml') ||
			request.url.includes('actionList')
		) {
			throw new Error(`connect ECONNREFUSED ${request.url}`)
		}
		return { status: 200, headers: {}, body: mockSonyCameraXml }
	}
}

async function createFixture(
	overrides: Parameters<typeof createTestHomeConnectorConfig>[0] = {},
	http: SonyIrccHttpClient = unreachableHttp(),
) {
	const config = createTestHomeConnectorConfig(overrides)
	const storage = await createHomeConnectorStorage(config)
	const wakeCalls: Array<{ host: string; macAddress: string }> = []
	const bluray = createSonyBlurayAdapter({
		config,
		storage,
		http,
		wakeOnLan: async (input) => {
			wakeCalls.push(input)
			return { targets: ['255.255.255.255'], ports: [9, 7] }
		},
	})
	return { config, storage, bluray, wakeCalls }
}

test('bluray status is not configured when host is empty', async () => {
	const { storage, bluray } = await createFixture()
	try {
		const status = await bluray.getStatus()
		expect(status.connected).toBe(false)
		expect(status.reasonCode).toBe('not_configured')
		expect(status.configured).toBe(false)
		expect(status.host).toBeNull()
		expect(status.reason).toMatch(/not configured/i)
		expect(status.reason).toMatch(/192\.168\.0\.115/)
		expect(status.reason).toMatch(/not the court Blu-ray/i)
		expect(status.rejectedSonyCamera.host).toBe('192.168.0.115')
		expect(status.avPath.hdmiSwitchInput).toBe(2)
	} finally {
		await storage.close()
	}
})

test('bluray status is disconnected when the configured host does not answer', async () => {
	const { storage, bluray } = await createFixture({
		courtBlurayHost: mockSonyBlurayHost,
	})
	try {
		const status = await bluray.getStatus()
		expect(status).toMatchObject({
			connected: false,
			reasonCode: 'probe_failed',
			configured: true,
			host: mockSonyBlurayHost,
		})
		expect(status.reason).toMatch(/did not respond/i)
		expect(status.probedEndpoints.length).toBeGreaterThan(0)
	} finally {
		await storage.close()
	}
})

test('never treats the Sony camera at .115 as the Blu-ray', async () => {
	const { storage, bluray } = await createFixture(
		{
			courtBlurayHost: courtSonyCameraNotThePlayer.host,
			courtBlurayMacAddress: courtSonyCameraNotThePlayer.macAddress,
		},
		cameraHttp(),
	)
	try {
		const status = await bluray.getStatus()
		expect(status.connected).toBe(false)
		expect(status.reasonCode).toBe('blocked_sony_camera')
		expect(status.reason).toMatch(/bisyamon/i)
		expect(status.host).toBe(courtSonyCameraNotThePlayer.host)

		const setHost = await bluray.setHost({
			host: courtSonyCameraNotThePlayer.host,
		})
		expect(setHost.connected).toBe(false)
		expect(setHost.reasonCode).toBe('blocked_sony_camera')

		const scanned = await bluray.scan({
			hosts: [courtSonyCameraNotThePlayer.host, mockSonyBlurayHost],
		})
		expect(scanned.players).toEqual([])
		expect(scanned.rejected[0]).toMatchObject({
			host: courtSonyCameraNotThePlayer.host,
			reasonCode: 'blocked_sony_camera',
		})
	} finally {
		await storage.close()
	}
})

test('successful IRCC probe reports connected and persists host/MAC', async () => {
	const { storage, bluray } = await createFixture(
		{
			courtBlurayHost: mockSonyBlurayHost,
			courtBlurayMacAddress: mockSonyBlurayMac,
		},
		fixtureHttp({}),
	)
	try {
		const status = await bluray.getStatus()
		expect(status.connected).toBe(true)
		expect(status.reasonCode).toBeNull()
		expect(status.host).toBe(mockSonyBlurayHost)
		expect(status.macAddress).toBe(mockSonyBlurayMac)
		expect(status.model).toBe('UBP-X800M2')
		expect(status.irccControlUrl).toBe(
			`http://${mockSonyBlurayHost}:50001/upnp/control/IRCC`,
		)
		expect(status.player?.host).toBe(mockSonyBlurayHost)
		const listed = await bluray.listPlayers()
		expect(listed).toHaveLength(1)
		expect(listed[0]).toMatchObject({
			host: mockSonyBlurayHost,
			macAddress: mockSonyBlurayMac,
			adopted: true,
		})
	} finally {
		await storage.close()
	}
})

test('IRCC send uses the BD1 play code on a reachable player', async () => {
	const { storage, bluray } = await createFixture(
		{ courtBlurayHost: mockSonyBlurayHost },
		fixtureHttp({}),
	)
	try {
		const result = await bluray.press('play')
		expect(result.connected).toBe(true)
		expect(result.command).toBe('play')
		expect(result.irccCode).toBe(getSonyIrccCode('play'))
		expect(result.transport).toBe('ircc')
		expect(result.httpStatus).toBe(200)
	} finally {
		await storage.close()
	}
})

test('transport tools return disconnected status when the player is off', async () => {
	const { storage, bluray } = await createFixture({
		courtBlurayHost: mockSonyBlurayHost,
	})
	try {
		const result = await bluray.press('pause')
		expect(result.connected).toBe(false)
		expect(result.reasonCode).toBe('probe_failed')
		expect(result.command).toBe('pause')
		expect(result.transport).toBeNull()
	} finally {
		await storage.close()
	}
})

test('powerOn sends WOL when a MAC is known even if IRCC is dark', async () => {
	const { storage, bluray, wakeCalls } = await createFixture({
		courtBlurayHost: mockSonyBlurayHost,
		courtBlurayMacAddress: mockSonyBlurayMac,
	})
	try {
		const result = await bluray.powerOn()
		expect(result.connected).toBe(false)
		expect(result.transport).toBe('wol')
		expect(result.wakeOnLan).toMatchObject({
			sent: true,
			macAddress: mockSonyBlurayMac,
		})
		expect(wakeCalls).toEqual([
			{ host: mockSonyBlurayHost, macAddress: mockSonyBlurayMac },
		])
	} finally {
		await storage.close()
	}
})

test('setHost persists then probes; forget returns not configured', async () => {
	const { storage, bluray } = await createFixture({}, fixtureHttp({}))
	try {
		const set = await bluray.setHost({
			host: mockSonyBlurayHost,
			macAddress: mockSonyBlurayMac,
			name: 'Court Blu-ray',
		})
		expect(set.connected).toBe(true)
		expect(set.host).toBe(mockSonyBlurayHost)
		const forgotten = await bluray.forget()
		expect(forgotten.connected).toBe(false)
		expect(forgotten.configured).toBe(false)
		expect(forgotten.reasonCode).toBe('not_configured')
	} finally {
		await storage.close()
	}
})

test('scan with no hosts does not invent the Sony camera', async () => {
	const { storage, bluray } = await createFixture()
	try {
		const result = await bluray.scan()
		expect(result.players).toEqual([])
		expect(result.rejected[0]?.reason).not.toMatch(
			/192\.168\.0\.115 is the player/,
		)
		expect(JSON.stringify(result)).not.toMatch(/"host":"192\.168\.0\.115"/)
	} finally {
		await storage.close()
	}
})

test('BD1 IRCC encoding matches sonyapilib pack format', () => {
	expect(encodeSonyIrccBd1Code(26)).toBe('AAAAAwAAHFoAAAAaAw==')
	expect(getSonyIrccCode('play')).toBe('AAAAAwAAHFoAAAAaAw==')
})

test('named powerOn and powerOff use distinct TV IRCC codes, not the BD1 toggle', () => {
	expect(getSonyIrccCode('powerOn')).toBe(sonyIrccTvCodes.powerOn)
	expect(getSonyIrccCode('powerOff')).toBe(sonyIrccTvCodes.powerOff)
	expect(getSonyIrccCode('powerOn')).not.toBe(getSonyIrccCode('powerOff'))
	expect(getSonyIrccCode('powerOn')).not.toBe(encodeSonyIrccBd1Code(21))
	expect(getSonyIrccCode('powerOff')).not.toBe(encodeSonyIrccBd1Code(21))
})

test('powerOn skips IRCC when the player is already reachable', async () => {
	const postedBodies: Array<string> = []
	const { storage, bluray, wakeCalls } = await createFixture(
		{
			courtBlurayHost: mockSonyBlurayHost,
			courtBlurayMacAddress: mockSonyBlurayMac,
		},
		fixtureHttp({ postedBodies }),
	)
	try {
		const result = await bluray.powerOn()
		expect(result.connected).toBe(true)
		expect(result.command).toBe('powerOn')
		expect(result.transport).toBeNull()
		expect(result.httpStatus).toBeNull()
		expect(postedBodies).toEqual([])
		expect(wakeCalls).toEqual([])
	} finally {
		await storage.close()
	}
})

test('scan adopts only the first unmatched host as court-bluray', async () => {
	const { storage, bluray } = await createFixture(
		{},
		fixtureHttp({ hosts: [mockSonyBlurayHost, mockSonyBlurayHostB] }),
	)
	try {
		const scanned = await bluray.scan({
			hosts: [mockSonyBlurayHost, mockSonyBlurayHostB],
		})
		expect(scanned.players.map((player) => player.playerId)).toEqual([
			courtBlurayPlayerId,
			`sony-ircc-${mockSonyBlurayHostB.replaceAll('.', '-')}`,
		])
		expect(scanned.players[0]?.host).toBe(mockSonyBlurayHost)
		expect(scanned.players[1]?.host).toBe(mockSonyBlurayHostB)

		const again = await bluray.scan({
			hosts: [mockSonyBlurayHostB, mockSonyBlurayHost],
		})
		const court = again.players.find(
			(player) => player.playerId === courtBlurayPlayerId,
		)
		expect(court?.host).toBe(mockSonyBlurayHost)
		expect(
			again.players.find((player) => player.host === mockSonyBlurayHostB)
				?.playerId,
		).toBe(`sony-ircc-${mockSonyBlurayHostB.replaceAll('.', '-')}`)
	} finally {
		await storage.close()
	}
})

test('forget does not fall back to an unadopted scanned player', async () => {
	const { storage, bluray } = await createFixture(
		{},
		fixtureHttp({ hosts: [mockSonyBlurayHost, mockSonyBlurayHostB] }),
	)
	try {
		await bluray.scan({
			hosts: [mockSonyBlurayHost, mockSonyBlurayHostB],
		})
		const forgotten = await bluray.forget()
		expect(forgotten.reasonCode).toBe('not_configured')
		expect(forgotten.host).toBeNull()
		const listed = await bluray.listPlayers()
		expect(
			listed.some((player) => player.playerId === courtBlurayPlayerId),
		).toBe(false)
		expect(
			listed.some(
				(player) => player.host === mockSonyBlurayHostB && !player.adopted,
			),
		).toBe(true)
		const status = await bluray.getStatus()
		expect(status.reasonCode).toBe('not_configured')
		expect(status.host).toBeNull()
		expect(status.player).toBeNull()
	} finally {
		await storage.close()
	}
})

test('changing COURT_BLURAY_HOST does not reuse the previous player credentials', async () => {
	const postedHeaders: Array<Record<string, string> | undefined> = []
	const { storage } = await createFixture({}, fixtureHttp({}))
	try {
		const first = createSonyBlurayAdapter({
			config: createTestHomeConnectorConfig({}),
			storage,
			http: fixtureHttp({}),
		})
		await first.setHost({
			host: mockSonyBlurayHost,
			authCookie: 'auth=old-court-cookie',
			psk: 'old-psk',
		})
		const second = createSonyBlurayAdapter({
			config: createTestHomeConnectorConfig({
				courtBlurayHost: mockSonyBlurayHostB,
			}),
			storage,
			http: fixtureHttp({
				host: mockSonyBlurayHostB,
				postedHeaders,
			}),
		})
		const result = await second.press('play')
		expect(result.connected).toBe(true)
		expect(result.host).toBe(mockSonyBlurayHostB)
		expect(postedHeaders.length).toBeGreaterThan(0)
		for (const headers of postedHeaders) {
			expect(headers?.Cookie ?? '').not.toMatch(/old-court-cookie/)
			expect(headers?.['X-Auth-PSK'] ?? '').not.toBe('old-psk')
		}
	} finally {
		await storage.close()
	}
})
