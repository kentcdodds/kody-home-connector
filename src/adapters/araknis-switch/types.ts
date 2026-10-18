export type AraknisSwitchConfigStatus = {
	configured: boolean
	baseUrl: string
	host: string | null
	missingFields: Array<string>
	allowInsecureTls: boolean
	sshEnabled: boolean
	sshPort: number
	hasStoredCredentials: boolean
	hasSharedSecret: boolean
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

export type AraknisSwitchVlan = {
	id: number
	name: string | null
	type: string | null
}

export type AraknisSwitchPortMembership = {
	port: string
	pvid: number | null
	taggedVlans: Array<number>
	untaggedVlans: Array<number>
	participationVlans: Array<number>
	acceptFrame: string | null
	switchportMode: 'access' | 'trunk' | 'general' | 'unknown'
}

export type AraknisSwitchPort = AraknisSwitchPortMembership & {
	description: string | null
	adminMode: string | null
	linkState: string | null
	speed: string | null
	type: string | null
	physicalAddress: string | null
}

export type AraknisSwitchVlanMembership = {
	vlan: AraknisSwitchVlan
	ports: Array<{
		port: string
		tagging: 'tagged' | 'untagged' | 'unknown'
		participation: 'include' | 'exclude' | 'unknown'
		pvid: number | null
		description: string | null
		linkState: string | null
	}>
	taggedPorts: Array<string>
	untaggedPorts: Array<string>
}

export type AraknisSwitchLldpNeighbor = {
	localPort: string | null
	remoteSystemName: string | null
	remotePortId: string | null
	remotePortDescription: string | null
	remoteChassisId: string | null
	managementAddresses: Array<string>
	rawLine: string | null
}

export type AraknisSwitchSystemInfo = {
	sysName: string | null
	sysDescr: string | null
	sysLocation: string | null
	sysContact: string | null
	hostname: string | null
	systemUpTimeSeconds: number | null
	burnedInMacAddress: string | null
	machineModel: string | null
	machineType: string | null
	baseBridgeAddress: string | null
	baseNumPorts: number | null
}

export type AraknisSwitchPoePort = {
	port: string
	adminMode: string | null
	detectionStatus: string | null
	powerClass: string | null
	powerWatts: number | null
	voltageVolts: number | null
	currentMilliamps: number | null
	priority: string | null
	raw: Record<string, unknown> | null
}

export type AraknisSwitchPoeStatus = {
	ports: Array<AraknisSwitchPoePort>
	source: 'open-v1' | 'ssh-cli' | 'unavailable'
	global: Record<string, unknown> | null
	errors: Array<string>
}

export type AraknisSwitchConfigSnapshot = {
	capturedAt: string
	system: AraknisSwitchSystemInfo
	vlans: Array<AraknisSwitchVlan>
	ports: Array<AraknisSwitchPort>
	poe: AraknisSwitchPoeStatus
}

export type AraknisSwitchStatus = {
	config: AraknisSwitchConfigStatus
	connected: boolean
	api: {
		kind: 'open-v1' | 'unavailable'
		loginOk: boolean
		systemReadable: boolean
		vlansReadable: boolean
		interfacesReadable: boolean
		poeReadable: boolean
		poeSource: AraknisSwitchPoeStatus['source']
		lldpReadable: boolean
		lldpSource: 'open-v1' | 'ssh-cli' | 'unavailable'
	}
	system: AraknisSwitchSystemInfo
	vlanCount: number
	portCount: number
	poePortCount: number
	errors: Array<string>
}

export type AraknisSwitchCredentials = {
	username: string
	password: string
}

export type AraknisSwitchClient = {
	login(): Promise<void>
	logout(): Promise<void>
	getDot1dBaseConfig(): Promise<Record<string, unknown>>
	getSystem1213(): Promise<Record<string, unknown>>
	getSystemMisc(): Promise<Record<string, unknown>>
	getRegistry(): Promise<Record<string, unknown>>
	listVlans(): Promise<Array<AraknisSwitchVlan>>
	getVlan(vlanId: number): Promise<{
		vlan: AraknisSwitchVlan
		members: Array<Record<string, unknown>>
	}>
	listInterfaces(): Promise<Array<Record<string, unknown>>>
	listPoe(): Promise<{
		ports: Array<Record<string, unknown>>
		global: Record<string, unknown> | null
		path: string | null
	}>
	listLldpNeighbors(): Promise<Array<AraknisSwitchLldpNeighbor>>
}
