export type AraknisSwitchConfigStatus = {
	configured: boolean
	baseUrl: string
	host: string | null
	missingFields: Array<string>
	allowInsecureTls: boolean
	sshEnabled: boolean
	sshPort: number
	hasUsername: boolean
	hasPassword: boolean
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

export type AraknisSwitchStatus = {
	config: AraknisSwitchConfigStatus
	connected: boolean
	api: {
		kind: 'open-v1' | 'unavailable'
		loginOk: boolean
		vlansReadable: boolean
		interfacesReadable: boolean
		lldpReadable: boolean
		lldpSource: 'open-v1' | 'ssh-cli' | 'unavailable'
	}
	system: {
		baseBridgeAddress: string | null
		baseNumPorts: number | null
	}
	vlanCount: number
	portCount: number
	errors: Array<string>
}

export type AraknisSwitchClient = {
	login(): Promise<void>
	logout(): Promise<void>
	getDot1dBaseConfig(): Promise<Record<string, unknown>>
	listVlans(): Promise<Array<AraknisSwitchVlan>>
	getVlan(vlanId: number): Promise<{
		vlan: AraknisSwitchVlan
		members: Array<Record<string, unknown>>
	}>
	listInterfaces(): Promise<Array<Record<string, unknown>>>
	listLldpNeighbors(): Promise<Array<AraknisSwitchLldpNeighbor>>
}
