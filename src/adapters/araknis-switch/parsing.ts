import {
	type AraknisSwitchLldpNeighbor,
	type AraknisSwitchPort,
	type AraknisSwitchPortMembership,
	type AraknisSwitchVlan,
	type AraknisSwitchVlanMembership,
} from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asString(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.trunc(value)
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return Math.trunc(parsed)
	}
	return null
}

function asNumberArray(value: unknown): Array<number> {
	if (!Array.isArray(value)) return []
	const numbers: Array<number> = []
	for (const entry of value) {
		const parsed = asNumber(entry)
		if (parsed != null) numbers.push(parsed)
	}
	return numbers
}

function uniqueSorted(values: Array<number>) {
	return [...new Set(values)].sort((a, b) => a - b)
}

export function deriveSwitchportMode(input: {
	taggedVlans: Array<number>
	untaggedVlans: Array<number>
}): AraknisSwitchPortMembership['switchportMode'] {
	if (input.taggedVlans.length === 0 && input.untaggedVlans.length <= 1) {
		return 'access'
	}
	if (input.taggedVlans.length > 0 && input.untaggedVlans.length <= 1) {
		return input.untaggedVlans.length === 0 ? 'trunk' : 'general'
	}
	if (input.taggedVlans.length > 0) return 'general'
	return 'unknown'
}

export function parseAraknisVlan(entry: unknown): AraknisSwitchVlan | null {
	if (!isRecord(entry)) return null
	const id = asNumber(entry['id'] ?? entry['vlanId'] ?? entry['vlan_id'])
	if (id == null) return null
	return {
		id,
		name: asString(entry['name']),
		type: asString(entry['type']),
	}
}

export function parseAraknisVlansPayload(
	payload: unknown,
): Array<AraknisSwitchVlan> {
	const records = isRecord(payload)
		? (payload['vlans'] ?? payload['vlan_element'] ?? payload)
		: payload
	if (!Array.isArray(records)) return []
	const vlans: Array<AraknisSwitchVlan> = []
	for (const entry of records) {
		const vlan = parseAraknisVlan(entry)
		if (vlan) vlans.push(vlan)
	}
	return vlans.sort((a, b) => a.id - b.id)
}

export function parseAraknisInterfaceMembership(
	entry: Record<string, unknown>,
): AraknisSwitchPortMembership {
	const port =
		asString(entry['interface'] ?? entry['id'] ?? entry['port']) ?? 'unknown'
	const pvid = asNumber(entry['pvId'] ?? entry['pvid'] ?? entry['pVid'])
	const participationRaw = entry['participation']
	const taggingRaw = entry['tagging']

	const participationVlans = Array.isArray(participationRaw)
		? asNumberArray(participationRaw)
		: []
	const taggedFromArray = Array.isArray(taggingRaw)
		? asNumberArray(taggingRaw)
		: []

	let taggedVlans = taggedFromArray
	let untaggedVlans: Array<number> = []

	if (Array.isArray(taggingRaw) && Array.isArray(participationRaw)) {
		untaggedVlans = participationVlans.filter(
			(vlanId) => !taggedFromArray.includes(vlanId),
		)
		if (untaggedVlans.length === 0 && pvid != null) {
			untaggedVlans = [pvid]
		}
	} else if (typeof taggingRaw === 'string') {
		const tagging = taggingRaw.trim().toLowerCase()
		if (tagging === 'tagged' && pvid != null) {
			taggedVlans = [pvid]
		} else if (tagging === 'untagged' && pvid != null) {
			untaggedVlans = [pvid]
		}
	} else if (pvid != null) {
		untaggedVlans = [pvid]
	}

	taggedVlans = uniqueSorted(taggedVlans)
	untaggedVlans = uniqueSorted(untaggedVlans)

	return {
		port,
		pvid,
		taggedVlans,
		untaggedVlans,
		participationVlans: uniqueSorted(
			participationVlans.length > 0
				? participationVlans
				: [...taggedVlans, ...untaggedVlans],
		),
		acceptFrame: asString(entry['acceptFrame'] ?? entry['accept_frame']),
		switchportMode: deriveSwitchportMode({ taggedVlans, untaggedVlans }),
	}
}

export function parseAraknisInterfacePort(
	entry: unknown,
): AraknisSwitchPort | null {
	if (!isRecord(entry)) return null
	const membership = parseAraknisInterfaceMembership(entry)
	if (membership.port === 'unknown') return null
	return {
		...membership,
		description: asString(entry['description'] ?? entry['name']),
		adminMode: asString(entry['adminMode'] ?? entry['admin_mode']),
		linkState: asString(entry['linkState'] ?? entry['link_state']),
		speed: asString(entry['speed']),
		type: asString(entry['type']),
		physicalAddress: asString(
			entry['physicalAddress'] ?? entry['physical_address'] ?? entry['mac'],
		),
	}
}

export function parseAraknisInterfacesPayload(
	payload: unknown,
): Array<AraknisSwitchPort> {
	const records = isRecord(payload)
		? (payload['interfaces'] ?? payload['port_element'] ?? payload)
		: payload
	if (!Array.isArray(records)) return []
	const ports: Array<AraknisSwitchPort> = []
	for (const entry of records) {
		const port = parseAraknisInterfacePort(entry)
		if (port) ports.push(port)
	}
	return ports.sort((a, b) =>
		a.port.localeCompare(b.port, undefined, { numeric: true }),
	)
}

export function buildVlanMembership(input: {
	vlan: AraknisSwitchVlan
	ports: Array<AraknisSwitchPort>
	memberRows?: Array<Record<string, unknown>>
}): AraknisSwitchVlanMembership {
	const byPort = new Map(input.ports.map((port) => [port.port, port]))
	const memberPorts: AraknisSwitchVlanMembership['ports'] = []

	if (input.memberRows && input.memberRows.length > 0) {
		for (const row of input.memberRows) {
			const portName =
				asString(row['interface'] ?? row['port'] ?? row['id']) ?? null
			if (!portName) continue
			const taggingRaw = asString(row['tagging'])?.toLowerCase()
			const participationRaw = asString(row['participation'])?.toLowerCase()
			const port = byPort.get(portName)
			const tagging =
				taggingRaw === 'tagged' || taggingRaw === 'untagged'
					? taggingRaw
					: port?.taggedVlans.includes(input.vlan.id)
						? 'tagged'
						: port?.untaggedVlans.includes(input.vlan.id)
							? 'untagged'
							: 'unknown'
			const participation =
				participationRaw === 'include' ||
				participationRaw === 'included' ||
				participationRaw === 'exclude' ||
				participationRaw === 'excluded'
					? participationRaw.startsWith('include')
						? 'include'
						: 'exclude'
					: tagging === 'unknown'
						? 'unknown'
						: 'include'
			memberPorts.push({
				port: portName,
				tagging,
				participation,
				pvid: asNumber(row['pvid'] ?? row['pvId']) ?? port?.pvid ?? null,
				description: port?.description ?? null,
				linkState: port?.linkState ?? null,
			})
		}
	} else {
		for (const port of input.ports) {
			const isTagged = port.taggedVlans.includes(input.vlan.id)
			const isUntagged = port.untaggedVlans.includes(input.vlan.id)
			if (!isTagged && !isUntagged) continue
			memberPorts.push({
				port: port.port,
				tagging: isTagged ? 'tagged' : 'untagged',
				participation: 'include',
				pvid: port.pvid,
				description: port.description,
				linkState: port.linkState,
			})
		}
	}

	memberPorts.sort((a, b) =>
		a.port.localeCompare(b.port, undefined, { numeric: true }),
	)

	return {
		vlan: input.vlan,
		ports: memberPorts,
		taggedPorts: memberPorts
			.filter((port) => port.tagging === 'tagged')
			.map((port) => port.port),
		untaggedPorts: memberPorts
			.filter((port) => port.tagging === 'untagged')
			.map((port) => port.port),
	}
}

/**
 * Parse Broadcom FASTPATH-style `show lldp remote-device` text.
 * Keeps raw lines for debugging without credentials.
 */
export function parseLldpRemoteDeviceCli(
	output: string,
): Array<AraknisSwitchLldpNeighbor> {
	const lines = output.split(/\r?\n/)
	const neighbors: Array<AraknisSwitchLldpNeighbor> = []
	let current: AraknisSwitchLldpNeighbor | null = null

	const flush = () => {
		if (!current) return
		if (
			current.localPort ||
			current.remoteSystemName ||
			current.remotePortId ||
			current.managementAddresses.length > 0
		) {
			neighbors.push(current)
		}
		current = null
	}

	for (const line of lines) {
		const localMatch =
			/^(?:Local\s+Interface|Interface|Port)\s*[.:]\s*(\S+)/i.exec(line) ??
			/^(\d+\/\d+)\s+/.exec(line.trim())
		if (localMatch && /interface|port|^\d+\/\d+/i.test(line)) {
			flush()
			current = {
				localPort: localMatch[1] ?? null,
				remoteSystemName: null,
				remotePortId: null,
				remotePortDescription: null,
				remoteChassisId: null,
				managementAddresses: [],
				rawLine: line.trim(),
			}
			continue
		}
		if (!current) continue

		const systemName =
			/(?:System\s+Name|Remote\s+Id|Chassis\s+ID\s+Subtype)\s*[.:]\s*(.+)$/i.exec(
				line,
			)
		if (/System\s+Name/i.test(line) && systemName) {
			current.remoteSystemName = systemName[1]?.trim() ?? null
			continue
		}
		const chassis = /(?:Chassis\s+ID|Chassis\s+Id)\s*[.:]\s*(.+)$/i.exec(line)
		if (chassis && !/Subtype/i.test(line)) {
			current.remoteChassisId = chassis[1]?.trim() ?? null
			continue
		}
		const portId = /(?:Port\s+ID|Remote\s+Port\s+ID)\s*[.:]\s*(.+)$/i.exec(line)
		if (portId && !/Subtype/i.test(line)) {
			current.remotePortId = portId[1]?.trim() ?? null
			continue
		}
		const portDesc =
			/(?:Port\s+Description|Remote\s+Port\s+Description)\s*[.:]\s*(.+)$/i.exec(
				line,
			)
		if (portDesc) {
			current.remotePortDescription = portDesc[1]?.trim() ?? null
			continue
		}
		const mgmt = /(?:Management\s+Address|IP\s+Address)\s*[.:]\s*(.+)$/i.exec(
			line,
		)
		if (mgmt?.[1]) {
			const address = mgmt[1].trim()
			if (address && !current.managementAddresses.includes(address)) {
				current.managementAddresses.push(address)
			}
		}
	}
	flush()

	// Table-style fallback: "0/1   RuckusAP   ... 192.168.0.10"
	if (neighbors.length === 0) {
		for (const line of lines) {
			const table = /^(?<local>\d+\/\d+)\s+(?<system>\S+)\s+(?<rest>.+)$/.exec(
				line.trim(),
			)
			if (!table?.groups) continue
			const addresses =
				table.groups.rest.match(
					/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f:]+%[A-Za-z0-9]+\b/gi,
				) ?? []
			neighbors.push({
				localPort: table.groups.local ?? null,
				remoteSystemName: table.groups.system ?? null,
				remotePortId: null,
				remotePortDescription: null,
				remoteChassisId: null,
				managementAddresses: addresses,
				rawLine: line.trim(),
			})
		}
	}

	return neighbors
}

export function parseOpenLldpNeighborsPayload(
	payload: unknown,
): Array<AraknisSwitchLldpNeighbor> {
	const records = isRecord(payload)
		? (payload['lldpremotedevices'] ??
			payload['lldpRemoteDevices'] ??
			payload['neighbors'] ??
			payload['remoteDevices'] ??
			payload)
		: payload
	if (!Array.isArray(records)) return []
	const neighbors: Array<AraknisSwitchLldpNeighbor> = []
	for (const entry of records) {
		if (!isRecord(entry)) continue
		const management =
			entry['managementAddresses'] ??
			entry['mgmtAddress'] ??
			entry['managementAddress'] ??
			entry['ipAddress']
		const addresses = Array.isArray(management)
			? management.map((value) => asString(value)).filter(Boolean)
			: asString(management)
				? [asString(management)!]
				: []
		neighbors.push({
			localPort: asString(
				entry['localPort'] ?? entry['interface'] ?? entry['port'],
			),
			remoteSystemName: asString(
				entry['systemName'] ??
					entry['remoteSystemName'] ??
					entry['sysName'] ??
					entry['name'],
			),
			remotePortId: asString(
				entry['portId'] ?? entry['remotePortId'] ?? entry['portID'],
			),
			remotePortDescription: asString(
				entry['portDescription'] ?? entry['remotePortDescription'],
			),
			remoteChassisId: asString(
				entry['chassisId'] ?? entry['remoteChassisId'] ?? entry['chassisID'],
			),
			managementAddresses: addresses as Array<string>,
			rawLine: null,
		})
	}
	return neighbors
}
