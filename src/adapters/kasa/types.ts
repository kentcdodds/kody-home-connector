export type KasaRelayState = 0 | 1

export type KasaSysInfo = Record<string, unknown> & {
	alias?: string
	model?: string
	mac?: string
	mic_mac?: string
	deviceId?: string
	dev_name?: string
	hwId?: string
	sw_ver?: string
	relay_state?: number
	led_off?: number
	on_time?: number
}

export type KasaDiscoveredPlug = {
	plugId: string
	alias: string
	host: string
	port: number
	model: string | null
	macAddress: string | null
	deviceId: string | null
	hwId: string | null
	swVer: string | null
	relayState: KasaRelayState | null
	ledOff: number | null
	onTime: number | null
	lastSeenAt: string
	rawSysInfo: KasaSysInfo
}

export type KasaPersistedPlug = KasaDiscoveredPlug & {
	adopted: boolean
	lastConnectedAt: string | null
	lastError: string | null
}

export type KasaPublicPlug = KasaPersistedPlug

export type KasaClient = {
	getSysInfo(input: {
		host: string
		port?: number
		timeoutMs?: number
	}): Promise<KasaSysInfo>
	setRelayState(input: {
		host: string
		port?: number
		state: KasaRelayState
		timeoutMs?: number
	}): Promise<Record<string, unknown>>
}

export type KasaProbeDiagnostic = {
	host: string
	port: number
	matched: boolean
	plugId: string | null
	alias: string | null
	model: string | null
	error: string | null
}

export type KasaSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	plugMatches: number
}

export type KasaDiscoveryDiagnostics = {
	protocol: 'subnet'
	discoveryUrl: string
	scannedAt: string
	probes: Array<KasaProbeDiagnostic>
	subnetProbe: KasaSubnetProbeSummary
}
