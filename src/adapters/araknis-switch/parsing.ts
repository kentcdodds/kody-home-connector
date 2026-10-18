import {
	type AraknisSwitchLldpNeighbor,
	type AraknisSwitchPoePort,
	type AraknisSwitchPort,
	type AraknisSwitchPortMembership,
	type AraknisSwitchSystemInfo,
	type AraknisSwitchVlan,
	type AraknisSwitchVlanMembership,
} from './types.ts'

export function emptyAraknisSystemInfo(): AraknisSwitchSystemInfo {
	return {
		sysName: null,
		sysDescr: null,
		sysLocation: null,
		sysContact: null,
		hostname: null,
		systemUpTimeSeconds: null,
		burnedInMacAddress: null,
		machineModel: null,
		machineType: null,
		baseBridgeAddress: null,
		baseNumPorts: null,
	}
}

export function parseAraknisSystemInfo(input: {
	system1213?: Record<string, unknown> | null
	systemMisc?: Record<string, unknown> | null
	registry?: Record<string, unknown> | null
	dot1dBase?: Record<string, unknown> | null
}): AraknisSwitchSystemInfo {
	const system1213 = input.system1213 ?? {}
	const systemMisc = input.systemMisc ?? {}
	const registry = input.registry ?? {}
	const dot1dBase = input.dot1dBase ?? {}
	const uptime =
		asNumber(systemMisc['systemUpTime']) ??
		asNumber(systemMisc['systemUptime']) ??
		asNumber(systemMisc['systemUpTimeSeconds'])
	return {
		sysName: asString(system1213['sysName']),
		sysDescr: asString(system1213['sysDescr']),
		sysLocation: asString(system1213['sysLocation']),
		sysContact: asString(system1213['sysContact']),
		hostname: asString(systemMisc['hostname']),
		systemUpTimeSeconds: uptime,
		burnedInMacAddress: asString(
			systemMisc['systemBurnedInMacAddr'] ??
				systemMisc['systemBurnedInMacAddress'],
		),
		machineModel: asString(registry['machineModel']),
		machineType: asString(registry['machineType']),
		baseBridgeAddress: asString(dot1dBase['baseBridgeAddress']),
		baseNumPorts: asNumber(dot1dBase['baseNumPorts']),
	}
}

function asFiniteNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return parsed
	}
	return null
}

export function parseAraknisPoePort(
	entry: unknown,
): AraknisSwitchPoePort | null {
	if (!isRecord(entry)) return null
	const port = asString(
		entry['interface'] ??
			entry['port'] ??
			entry['intf'] ??
			entry['portId'] ??
			entry['port_id'],
	)
	if (!port) return null
	return {
		port,
		adminMode: asString(
			entry['adminMode'] ?? entry['poeAdminMode'] ?? entry['admin'],
		),
		detectionStatus: asString(
			entry['detectionStatus'] ??
				entry['operStatus'] ??
				entry['status'] ??
				entry['poeStatus'],
		),
		powerClass: asString(
			entry['powerClass'] ?? entry['class'] ?? entry['pdClass'],
		),
		powerWatts: asFiniteNumber(
			entry['powerWatts'] ??
				entry['outputPower'] ??
				entry['power'] ??
				entry['consumedPower'],
		),
		voltageVolts: asFiniteNumber(entry['voltage'] ?? entry['voltageVolts']),
		currentMilliamps: asFiniteNumber(
			entry['current'] ?? entry['currentMilliamps'] ?? entry['currentMa'],
		),
		priority: asString(entry['priority'] ?? entry['poePriority']),
		raw: entry,
	}
}

export function parseAraknisPoePayload(payload: unknown): {
	ports: Array<AraknisSwitchPoePort>
	global: Record<string, unknown> | null
} {
	if (!payload) return { ports: [], global: null }
	const records = isRecord(payload)
		? (payload['poeInterfaces'] ??
			payload['poeinterfaces'] ??
			payload['interfaces'] ??
			payload['ports'] ??
			payload['port_element'] ??
			payload['poePort'] ??
			payload)
		: payload
	const ports: Array<AraknisSwitchPoePort> = []
	if (Array.isArray(records)) {
		for (const entry of records) {
			const port = parseAraknisPoePort(entry)
			if (port) ports.push(port)
		}
	}
	const global = isRecord(payload)
		? isRecord(payload['poeGlobal'])
			? payload['poeGlobal']
			: isRecord(payload['global'])
				? payload['global']
				: ports.length === 0 && !Array.isArray(records)
					? payload
					: null
		: null
	return {
		ports: ports.sort((a, b) =>
			a.port.localeCompare(b.port, undefined, { numeric: true }),
		),
		global,
	}
}

/**
 * Parse FASTPATH-style `show power inline` / `show poe` CLI text.
 * Tolerates table and key/value layouts; returns empty when unrecognized.
 */
export function parsePoePowerInlineCli(
	text: string,
): Array<AraknisSwitchPoePort> {
	const ports: Array<AraknisSwitchPoePort> = []
	const seen = new Set<string>()
	const lines = text.split(/\r?\n/)
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed || /^[-|=]+$/.test(trimmed)) continue
		// Example: "0/5   Auto   Delivering Power   Class 4   12.4"
		const tableMatch =
			/^(\d+\/\d+)\s+(\S+)\s+(.+?)\s+(Class\s+\S+|N\/A|\S+)\s+([\d.]+)\s*$/i.exec(
				trimmed,
			)
		if (tableMatch) {
			const port = tableMatch[1]!
			if (seen.has(port)) continue
			seen.add(port)
			ports.push({
				port,
				adminMode: tableMatch[2] ?? null,
				detectionStatus: tableMatch[3]?.trim() ?? null,
				powerClass: tableMatch[4] ?? null,
				powerWatts: asFiniteNumber(tableMatch[5]),
				voltageVolts: null,
				currentMilliamps: null,
				priority: null,
				raw: null,
			})
			continue
		}
		const portOnly = /^Int(?:erface)?\s*[:=]\s*(\d+\/\d+)/i.exec(trimmed)
		if (portOnly) {
			const port = portOnly[1]!
			if (!seen.has(port)) {
				seen.add(port)
				ports.push({
					port,
					adminMode: null,
					detectionStatus: null,
					powerClass: null,
					powerWatts: null,
					voltageVolts: null,
					currentMilliamps: null,
					priority: null,
					raw: null,
				})
			}
		}
	}
	return ports.sort((a, b) =>
		a.port.localeCompare(b.port, undefined, { numeric: true }),
	)
}

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
		// String tagging without a VLAN array cannot invent tagged membership
		// from PVID — PVID is the native/untagged VLAN.
		if (tagging === 'untagged' && pvid != null) {
			untaggedVlans = [pvid]
		} else if (tagging === 'tagged' && pvid != null) {
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

	const seen = new Set<string>()

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
			seen.add(portName)
		}
	}

	// Always merge interface-derived membership so incomplete memberRows cannot
	// hide tagged/untagged AP or uplink ports present on the interfaces list.
	for (const port of input.ports) {
		if (seen.has(port.port)) continue
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

	memberPorts.sort((a, b) =>
		a.port.localeCompare(b.port, undefined, { numeric: true }),
	)

	const included = memberPorts.filter(
		(port) => port.participation !== 'exclude',
	)

	return {
		vlan: input.vlan,
		ports: memberPorts,
		taggedPorts: included
			.filter((port) => port.tagging === 'tagged')
			.map((port) => port.port),
		untaggedPorts: included
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
		// Only treat labeled "Local Interface:" / "Interface:" / "Port:" blocks as
		// detail-style neighbors. Bare "0/5 …" rows belong to the table fallback.
		const localMatch =
			/^(?:Local\s+Interface|Interface|Port)\s*[.:]\s*(\S+)/i.exec(line)
		if (localMatch) {
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
