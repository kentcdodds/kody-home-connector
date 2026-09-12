import {
	type PjlinkAvMuteMode,
	type PjlinkHandshake,
	type PjlinkInputClass,
	type PjlinkPowerState,
} from './protocol.ts'

export const courtOptomaDefaults = {
	name: 'Court Optoma ZK810TST',
	host: '192.168.0.128',
	macAddress: '00:50:41:B2:FD:09',
	port: 4352,
} as const

export type PjlinkDiscoveredProjector = {
	projectorId: string
	name: string
	host: string
	port: number
	macAddress: string | null
	manufacturer: string | null
	model: string | null
	authRequired: boolean
	lastSeenAt: string | null
	rawDiscovery: Record<string, unknown> | null
}

export type PjlinkPersistedProjector = PjlinkDiscoveredProjector & {
	adopted: boolean
	hasPassword: boolean
}

export type PjlinkPublicProjector = PjlinkPersistedProjector

export type PjlinkProjectorSelector = {
	projectorId?: string
	name?: string
	host?: string
}

export type PjlinkDiscoveryProbeDiagnostic = {
	host: string
	port: number
	matched: boolean
	authRequired: boolean | null
	name: string | null
	projectorId: string | null
	error: string | null
}

export type PjlinkSubnetProbeSummary = {
	cidrs: Array<string>
	extraHosts: Array<string>
	hostsProbed: number
	pjlinkMatches: number
}

export type PjlinkDiscoveryDiagnostics = {
	protocol: 'pjlink'
	discoveryUrl: string
	scannedAt: string
	probes: Array<PjlinkDiscoveryProbeDiagnostic>
	subnetProbe: PjlinkSubnetProbeSummary
}

export type PjlinkDiscoveryResult = {
	projectors: Array<PjlinkDiscoveredProjector>
	diagnostics: PjlinkDiscoveryDiagnostics
}

export type PjlinkCommandClient = (input: {
	host: string
	port: number
	password?: string | null
	timeoutMs?: number
	command: string
	parameter: string
}) => Promise<{
	handshake: PjlinkHandshake
	value: string
	raw: string
}>

export type PjlinkPowerResult = {
	projector: PjlinkPublicProjector
	power: PjlinkPowerState
	command: 'on' | 'off' | 'query'
	raw: string
}

export type PjlinkInputResult = {
	projector: PjlinkPublicProjector
	inputClass: PjlinkInputClass
	channel: number
	code: string
	raw: string
}

export type PjlinkAvMuteResult = {
	projector: PjlinkPublicProjector
	mode: PjlinkAvMuteMode
	raw: string
}

export type PjlinkLampResult = {
	projector: PjlinkPublicProjector
	lamps: Array<{ hours: number; on: boolean }>
	raw: string
}

export type PjlinkInfoResult = {
	projector: PjlinkPublicProjector
	name: string | null
	manufacturer: string | null
	model: string | null
	info: string | null
	pjlinkClass: string | null
	raw: Record<string, string>
}

export type PjlinkAdoptInput = {
	projectorId?: string
	name?: string
	host?: string
	port?: number
	macAddress?: string
	password?: string | null
}
