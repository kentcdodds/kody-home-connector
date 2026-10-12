export const araknisLoginSuccess = {
	SIDSSL: 'test-session-id-not-a-secret',
	accessLevel: 15,
}

export const araknisDot1dBaseConfig = {
	baseBridgeAddress: '14:3f:c3:94:3b:d7',
	baseNumPorts: 26,
	baseType: 2,
	status: { response_code: 200, msg: 'OK', more_info: '', error_code: 0 },
}

export const araknisVlansPayload = {
	vlans: [
		{ id: 1, type: 'default', name: 'DEFAULT' },
		{ id: 20, type: 'static', name: 'AP' },
		{ id: 30, type: 'static', name: 'IoT' },
	],
	status: { response_code: 200, msg: 'OK', more_info: '', error_code: 0 },
}

export const araknisVlan20Payload = {
	vlans: [{ id: 20, type: 'static', name: 'AP' }],
	interfaces: [
		{
			interface: '0/5',
			pvid: 1,
			participation: 'include',
			tagging: 'tagged',
		},
		{
			interface: '0/6',
			pvid: 1,
			participation: 'include',
			tagging: 'tagged',
		},
		{
			interface: '0/24',
			pvid: 1,
			participation: 'include',
			tagging: 'tagged',
		},
	],
	status: { response_code: 200, msg: 'OK', more_info: '', error_code: 0 },
}

export const araknisInterfacesPayload = {
	interfaces: [
		{
			interface: '0/5',
			description: 'Ruckus-R550-1',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:55',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/6',
			description: 'Ruckus-R550-2',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:56',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/7',
			description: 'Ruckus-R550-3',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:57',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/8',
			description: 'Ruckus-R550-4',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:58',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/9',
			description: 'Ruckus-R550-5',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:59',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/10',
			description: 'Ruckus-R550-6',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:5a',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/11',
			description: 'Ruckus-R550-7',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '2.5G-full-duplex',
			type: 'physical',
			physicalAddress: '00:11:22:33:44:5b',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20],
			tagging: [20],
		},
		{
			interface: '0/24',
			description: 'Island-uplink',
			adminMode: 'enabled',
			linkState: 'up',
			speed: '10G-full-duplex',
			type: 'physical',
			physicalAddress: '14:3f:c3:94:3b:f0',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1, 20, 30],
			tagging: [20, 30],
		},
		{
			interface: '0/1',
			description: 'Access-only',
			adminMode: 'enabled',
			linkState: 'down',
			speed: 'unknown',
			type: 'physical',
			physicalAddress: '14:3f:c3:94:3b:d8',
			pvId: 1,
			acceptFrame: 'all',
			participation: [1],
			tagging: [],
		},
	],
	status: { response_code: 200, msg: 'OK', more_info: '', error_code: 0 },
}

export const araknisLldpCliSample = `
Local Interface: 0/5
System Name: RuckusAP-1
Chassis ID: 00:11:22:33:44:55
Port ID: eth0
Port Description: eth0
Management Address: 192.168.0.101

Local Interface: 0/24
System Name: Island
Chassis ID: b4:a8:b9:38:7a:bf
Port ID: en1
Management Address: 192.168.0.1
`
