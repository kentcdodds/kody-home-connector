import { expect, test } from 'vitest'
import {
	araknisInterfacesPayload,
	araknisLldpCliSample,
	araknisVlansPayload,
} from './fixtures.ts'
import {
	buildVlanMembership,
	parseAraknisInterfacesPayload,
	parseAraknisVlansPayload,
	parseLldpRemoteDeviceCli,
} from './parsing.ts'

test('parseAraknisVlansPayload reads OpEN vlan collection', () => {
	expect(parseAraknisVlansPayload(araknisVlansPayload)).toEqual([
		{ id: 1, name: 'DEFAULT', type: 'default' },
		{ id: 20, name: 'AP', type: 'static' },
		{ id: 30, name: 'IoT', type: 'static' },
	])
})

test('parseAraknisInterfacesPayload derives tagged/untagged membership and modes', () => {
	const ports = parseAraknisInterfacesPayload(araknisInterfacesPayload)
	const apPort = ports.find((port) => port.port === '0/5')
	expect(apPort).toMatchObject({
		port: '0/5',
		description: 'Ruckus-R550-1',
		pvid: 1,
		taggedVlans: [20],
		untaggedVlans: [1],
		switchportMode: 'general',
		linkState: 'up',
	})

	const access = ports.find((port) => port.port === '0/1')
	expect(access).toMatchObject({
		taggedVlans: [],
		untaggedVlans: [1],
		switchportMode: 'access',
	})

	const uplink = ports.find((port) => port.port === '0/24')
	expect(uplink).toMatchObject({
		description: 'Island-uplink',
		taggedVlans: [20, 30],
		untaggedVlans: [1],
	})
})

test('buildVlanMembership highlights tagged AP and Island uplink ports for VLAN 20', () => {
	const ports = parseAraknisInterfacesPayload(araknisInterfacesPayload)
	const membership = buildVlanMembership({
		vlan: { id: 20, name: 'AP', type: 'static' },
		ports,
	})
	expect(membership.taggedPorts).toEqual([
		'0/5',
		'0/6',
		'0/7',
		'0/8',
		'0/9',
		'0/10',
		'0/11',
		'0/24',
	])
	expect(membership.untaggedPorts).toEqual([])
})

test('parseLldpRemoteDeviceCli extracts remote systems without credentials', () => {
	const neighbors = parseLldpRemoteDeviceCli(araknisLldpCliSample)
	expect(neighbors).toEqual([
		{
			localPort: '0/5',
			remoteSystemName: 'RuckusAP-1',
			remotePortId: 'eth0',
			remotePortDescription: 'eth0',
			remoteChassisId: '00:11:22:33:44:55',
			managementAddresses: ['192.168.0.101'],
			rawLine: 'Local Interface: 0/5',
		},
		{
			localPort: '0/24',
			remoteSystemName: 'Island',
			remotePortId: 'en1',
			remotePortDescription: null,
			remoteChassisId: 'b4:a8:b9:38:7a:bf',
			managementAddresses: ['192.168.0.1'],
			rawLine: 'Local Interface: 0/24',
		},
	])
})
