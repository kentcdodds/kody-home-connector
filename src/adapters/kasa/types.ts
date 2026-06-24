export type KasaRelayState = 'on' | 'off' | 'unknown'

export type KasaSysInfo = Record<string, unknown> & {
	alias?: string
	model?: string
	mic_type?: string
	mac?: string
	device_id?: string
	relay_state?: number | boolean
}

export type KasaCredentials = {
	username: string
	password: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
	source: 'stored' | 'env'
}

export type KasaDiscoveredPlug = {
	plugId: string
	alias: string
	host: string
	port: number
	model: string | null
	mac: string | null
	deviceId: string | null
	relayState: KasaRelayState
	rawSysinfo: KasaSysInfo | null
	rawDiscovery: Record<string, unknown> | null
	lastSeenAt: string | null
}

export type KasaPersistedPlug = KasaDiscoveredPlug & {
	adopted: boolean
}

export type KasaPublicPlug = KasaPersistedPlug & {
	hasCredentials: boolean
}

export type KasaDiscoveryProbeDiagnostic = {
	host: string
	port: number
	source: 'udp' | 'subnet'
	matched: boolean
	alias: string | null
	plugId: string | null
	status: number | null
	server: string | null
	error: string | null
}

export type KasaSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	shipMatches: number
	authenticatedMatches: number
}

export type KasaDiscoveryDiagnostics = {
	protocol: 'klap'
	discoveryUrl: string
	scannedAt: string
	udpPorts: Array<number>
	probes: Array<KasaDiscoveryProbeDiagnostic>
	subnetProbe: KasaSubnetProbeSummary
	credentialStatus: 'present' | 'missing'
}

export type KasaDiscoveryResult = {
	plugs: Array<KasaDiscoveredPlug>
	diagnostics: KasaDiscoveryDiagnostics
}

export type KasaPlugSelector = {
	plugId?: string
	alias?: string
}

export type KasaClientCredentials = {
	username: string
	password: string
}

export type KasaClient = {
	getSysInfo(): Promise<KasaSysInfo>
	setRelayState(state: boolean): Promise<Record<string, unknown>>
}
