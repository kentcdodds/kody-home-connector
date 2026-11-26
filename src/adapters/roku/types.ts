export type RokuDiscoveredDevice = {
	id: string
	name: string
	location: string
	serialNumber: string | null
	modelName: string | null
	isAdopted: boolean
	lastSeenAt: string | null
	controlEnabled: boolean
}

export type RokuSsdpHitDiagnostic = {
	receivedAt: string
	remoteAddress: string
	remotePort: number
	raw: string
	location: string | null
	usn: string | null
	server: string | null
}

export type RokuDeviceInfoDiagnostic = {
	location: string
	deviceInfoUrl: string
	raw: string | null
	parsed: {
		name: string | null
		serialNumber: string | null
		modelName: string | null
	} | null
	error: string | null
}

export type RokuDiscoveryDiagnostics = {
	protocol: 'json' | 'ssdp'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	ssdpHits: Array<RokuSsdpHitDiagnostic>
	deviceInfoLookups: Array<RokuDeviceInfoDiagnostic>
}

export type RokuDiscoveryResult = {
	devices: Array<RokuDiscoveredDevice>
	diagnostics: RokuDiscoveryDiagnostics
}

export type RokuDeviceRecord = RokuDiscoveredDevice & {
	deviceId: string
	adopted: boolean
}

export type RokuAppInfo = {
	id: string
	name: string
	type: string
	version: string
}

export type RokuAppListResult = {
	deviceId: string
	deviceName: string
	apps: Array<RokuAppInfo>
	responseText: string
	addressHealed?: RokuAddressHealed
}

export type RokuActiveAppResult = {
	deviceId: string
	deviceName: string
	app: RokuAppInfo | null
	responseText: string
	addressHealed?: RokuAddressHealed
}

export type RokuAddressHealed = {
	from: string
	to: string
}

export type RokuMediaPlayerResult = {
	deviceId: string
	deviceName: string
	state: string | null
	error: boolean | null
	plugin: { id: string; name: string } | null
	positionMs: number | null
	durationMs: number | null
	isLive: boolean | null
	responseText: string
	mediaPlayerError: string | null
	activeApp: RokuAppInfo | null
	activeAppError: string | null
	addressHealed?: RokuAddressHealed
}

export type RokuPlayYouTubeResult = {
	launched: true
	deviceId: string
	deviceName: string
	videoId: string
	appId: string
	mediaType: string | null
	verified: boolean
	playerState: string | null
	activeApp: RokuAppInfo | null
	warnings: Array<string>
	addressHealed?: RokuAddressHealed
}
