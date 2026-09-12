export const courtSonyCameraNotThePlayer = {
	host: '192.168.0.115',
	macAddress: 'F8:4E:17:21:ED:B2',
	oui: 'f8:4e:17',
	name: 'Sony camera (bisyamon)',
	reason:
		'192.168.0.115 (f8:4e:17:21:ed:b2) is the Sony camera (bisyamon), not the court Blu-ray. Ircc.xml / actionList / dmr.xml fail there. Never hardcode or auto-pick it as the player.',
} as const

export const courtBlurayAvPath = {
	hdmiSwitchInput: 2 as const,
	notes:
		'Blu-ray → Blustream HEX150CS-TX → Cat6 → MROCIOA HDMI switch input 2 → projector. Roku is switch input 1. Do not bypass the switch or court Sonos HDMI/TV audio is lost.',
}

export const sonyIrccDefaultTimeoutMs = 1_500
export const sonyIrccDefaultName = 'Court Sony UHD Blu-ray'
export const courtBlurayPlayerId = 'court-bluray'

export const sonyIrccProbePaths = [
	{ port: 50001, path: '/Ircc.xml' },
	{ port: 50002, path: '/actionList' },
	{ port: 52323, path: '/dmr.xml' },
] as const

export const sonyIrccControlPathCandidates = [
	{ port: 50001, path: '/upnp/control/IRCC' },
	{ port: 52323, path: '/upnp/control/IRCC' },
	{ port: 80, path: '/sony/ircc' },
	{ port: 50001, path: '/IRCC' },
] as const

export type SonyIrccDisconnectReason =
	| 'not_configured'
	| 'blocked_sony_camera'
	| 'probe_failed'
	| 'not_ircc_player'
	| 'unreachable'

export type SonyIrccProbeEndpoint = {
	url: string
	ok: boolean
	status: number | null
	matched: boolean
	error: string | null
}

export type SonyIrccPersistedPlayer = {
	playerId: string
	name: string
	host: string
	macAddress: string | null
	model: string | null
	manufacturer: string | null
	irccControlUrl: string | null
	hasAuthCookie: boolean
	hasPsk: boolean
	adopted: boolean
	lastSeenAt: string | null
	rawProbe: Record<string, unknown> | null
}

export type SonyIrccStatus = {
	connected: boolean
	reason: string
	reasonCode: SonyIrccDisconnectReason | null
	configured: boolean
	host: string | null
	macAddress: string | null
	name: string | null
	model: string | null
	manufacturer: string | null
	playerId: string | null
	irccControlUrl: string | null
	hasAuth: boolean
	probedEndpoints: Array<SonyIrccProbeEndpoint>
	avPath: typeof courtBlurayAvPath
	rejectedSonyCamera: typeof courtSonyCameraNotThePlayer
	pairingNotes: string
	player: SonyIrccPersistedPlayer | null
}

export type SonyIrccCommandResult = SonyIrccStatus & {
	command: string | null
	irccCode: string | null
	transport: 'ircc' | 'wol' | null
	wakeOnLan: {
		sent: boolean
		macAddress: string | null
		targets: Array<string>
		error: string | null
	} | null
	httpStatus: number | null
}

export type SonyIrccScanResult = {
	players: Array<SonyIrccPersistedPlayer>
	rejected: Array<{
		host: string
		reason: string
		reasonCode: SonyIrccDisconnectReason
	}>
	probes: Array<SonyIrccProbeEndpoint & { host: string }>
}

export type SonyIrccHttpResponse = {
	status: number
	headers: Record<string, string>
	body: string
}

export type SonyIrccHttpClient = (input: {
	url: string
	method: 'GET' | 'POST'
	headers?: Record<string, string>
	body?: string
	timeoutMs: number
}) => Promise<SonyIrccHttpResponse>

export type SonyIrccWakeOnLanSender = (input: {
	host: string
	macAddress: string
}) => Promise<{ targets: Array<string>; ports: Array<number> }>

export type SonyIrccSetHostInput = {
	host: string
	macAddress?: string | null
	name?: string | null
	authCookie?: string | null
	psk?: string | null
}
