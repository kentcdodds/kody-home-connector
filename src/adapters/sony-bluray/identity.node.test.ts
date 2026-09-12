import { expect, test } from 'vitest'
import {
	mockSonyBlurayHost,
	mockSonyBlurayHostB,
	mockSonyDmrXmlAvTransportFirst,
	mockSonyIrccXml,
} from './fixtures.ts'
import {
	buildSonyIrccPlayerId,
	extractIrccControlUrl,
	resolveScanSonyIrccPlayerId,
} from './identity.ts'
import { courtBlurayPlayerId } from './types.ts'

test('extractIrccControlUrl uses the IRCC service, not the first controlURL', () => {
	expect(
		extractIrccControlUrl({
			host: mockSonyBlurayHost,
			body: mockSonyDmrXmlAvTransportFirst,
			baseUrl: `http://${mockSonyBlurayHost}:52323/dmr.xml`,
		}),
	).toBe(`http://${mockSonyBlurayHost}:52323/upnp/control/IRCC`)
	expect(
		extractIrccControlUrl({
			host: mockSonyBlurayHost,
			body: mockSonyIrccXml,
			baseUrl: `http://${mockSonyBlurayHost}:50001/Ircc.xml`,
		}),
	).toBe(`http://${mockSonyBlurayHost}:50001/upnp/control/IRCC`)
})

test('scan assigns court-bluray only to the env host or the first unmatched adopt', () => {
	expect(
		resolveScanSonyIrccPlayerId({
			host: mockSonyBlurayHost,
			envHost: mockSonyBlurayHost,
			courtPlayerHost: null,
			existingPlayerIdForHost: null,
			assignedCourtThisScan: false,
		}),
	).toBe(courtBlurayPlayerId)

	expect(
		resolveScanSonyIrccPlayerId({
			host: mockSonyBlurayHostB,
			envHost: mockSonyBlurayHost,
			courtPlayerHost: null,
			existingPlayerIdForHost: null,
			assignedCourtThisScan: false,
		}),
	).toBe(buildSonyIrccPlayerId(mockSonyBlurayHostB))

	expect(
		resolveScanSonyIrccPlayerId({
			host: mockSonyBlurayHost,
			envHost: null,
			courtPlayerHost: null,
			existingPlayerIdForHost: null,
			assignedCourtThisScan: false,
		}),
	).toBe(courtBlurayPlayerId)

	expect(
		resolveScanSonyIrccPlayerId({
			host: mockSonyBlurayHostB,
			envHost: null,
			courtPlayerHost: null,
			existingPlayerIdForHost: null,
			assignedCourtThisScan: true,
		}),
	).toBe(buildSonyIrccPlayerId(mockSonyBlurayHostB))

	expect(
		resolveScanSonyIrccPlayerId({
			host: mockSonyBlurayHostB,
			envHost: null,
			courtPlayerHost: mockSonyBlurayHost,
			existingPlayerIdForHost: null,
			assignedCourtThisScan: false,
		}),
	).toBe(buildSonyIrccPlayerId(mockSonyBlurayHostB))

	expect(
		resolveScanSonyIrccPlayerId({
			host: mockSonyBlurayHost,
			envHost: null,
			courtPlayerHost: mockSonyBlurayHost,
			existingPlayerIdForHost: courtBlurayPlayerId,
			assignedCourtThisScan: false,
		}),
	).toBe(courtBlurayPlayerId)
})
