import { expect, test } from 'vitest'
import {
	araknisInterfacesPayload,
	araknisLldpCliSample,
	araknisPoeCliSample,
	araknisPoeInterfacesPayload,
	araknisRegistry,
	araknisSystem1213,
	araknisSystemMisc,
	araknisDot1dBaseConfig,
	araknisVlansPayload,
} from './fixtures.ts'
import {
	buildVlanMembership,
	parseAraknisInterfacesPayload,
	parseAraknisPoePayload,
	parseAraknisSystemInfo,
	parseAraknisVlansPayload,
	parseLldpRemoteDeviceCli,
	parsePoePowerInlineCli,
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

test('parseLldpRemoteDeviceCli keeps table-style neighbor details', () => {
	const neighbors = parseLldpRemoteDeviceCli(`
Local Port   Remote ID     Chassis ID         Mgmt Addr
---------    ---------     ----------         ---------
0/5          RuckusAP-1    00:11:22:33:44:55  192.168.0.101
0/24         Island        b4:a8:b9:38:7a:bf  192.168.0.1
`)
	expect(neighbors).toEqual([
		{
			localPort: '0/5',
			remoteSystemName: 'RuckusAP-1',
			remotePortId: null,
			remotePortDescription: null,
			remoteChassisId: null,
			managementAddresses: ['192.168.0.101'],
			rawLine: '0/5          RuckusAP-1    00:11:22:33:44:55  192.168.0.101',
		},
		{
			localPort: '0/24',
			remoteSystemName: 'Island',
			remotePortId: null,
			remotePortDescription: null,
			remoteChassisId: null,
			managementAddresses: ['192.168.0.1'],
			rawLine: '0/24         Island        b4:a8:b9:38:7a:bf  192.168.0.1',
		},
	])
})

test('buildVlanMembership merges interface ports and excludes participation=exclude', () => {
	const ports = parseAraknisInterfacesPayload(araknisInterfacesPayload)
	const membership = buildVlanMembership({
		vlan: { id: 20, name: 'AP', type: 'static' },
		ports,
		memberRows: [
			{
				interface: '0/5',
				participation: 'include',
				tagging: 'tagged',
			},
			{
				interface: '0/99',
				participation: 'exclude',
				tagging: 'tagged',
			},
		],
	})
	expect(membership.taggedPorts).toContain('0/5')
	expect(membership.taggedPorts).toContain('0/24')
	expect(membership.taggedPorts).not.toContain('0/99')
	expect(
		membership.ports.find((port) => port.port === '0/99')?.participation,
	).toBe('exclude')
})

test('parseAraknisSystemInfo merges OpEN system resources', () => {
	expect(
		parseAraknisSystemInfo({
			system1213: araknisSystem1213,
			systemMisc: araknisSystemMisc,
			registry: araknisRegistry,
			dot1dBase: araknisDot1dBaseConfig,
		}),
	).toMatchObject({
		sysName: 'core-switch',
		hostname: 'core-switch',
		machineModel: 'AN-620-SW-R-24-POE',
		baseNumPorts: 26,
		systemUpTimeSeconds: 123456,
	})
})

test('parseAraknisPoePayload and CLI parser read PoE status', () => {
	const openPoe = parseAraknisPoePayload(araknisPoeInterfacesPayload)
	expect(openPoe.ports).toHaveLength(2)
	expect(openPoe.ports[0]).toMatchObject({
		port: '0/5',
		detectionStatus: 'Delivering Power',
		powerWatts: 12.4,
	})
	const cliPoe = parsePoePowerInlineCli(araknisPoeCliSample)
	expect(cliPoe.map((port) => port.port)).toEqual(['0/5', '0/6'])
	expect(cliPoe[0]?.powerWatts).toBe(12.4)
})
