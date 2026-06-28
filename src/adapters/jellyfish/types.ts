export const jellyfishDefaultPort = 9000

export type JellyfishDiscoveredController = {
	controllerId: string
	name: string
	hostname: string
	host: string
	port: number
	firmwareVersion: string | null
	lastSeenAt: string
	rawDiscovery: Record<string, unknown>
}

export type JellyfishPersistedController = {
	controllerId: string
	name: string
	hostname: string
	host: string
	port: number
	firmwareVersion: string | null
	lastSeenAt: string | null
	lastConnectedAt: string | null
	lastError: string | null
}

export type JellyfishZone = {
	name: string
	numPixels: number | null
	portMap: Array<Record<string, unknown>>
}

export type JellyfishPattern = {
	path: string
	folder: string
	name: string
	readOnly: boolean
}

export type JellyfishPatternData = {
	path: string
	folder: string
	name: string
	data: Record<string, unknown>
	rawJsonData: string
}

export const jellyfishDailyScheduleDays = [
	'M',
	'T',
	'W',
	'TH',
	'F',
	'SA',
	'S',
] as const

export const jellyfishScheduleActionTypes = ['RUN', 'STOP'] as const

export const jellyfishScheduleActionStartFromValues = [
	'sunrise',
	'sunset',
	'time',
] as const

export type JellyfishScheduleType = 'daily' | 'calendar'

export type JellyfishScheduleActionType =
	(typeof jellyfishScheduleActionTypes)[number]

export type JellyfishScheduleActionStartFrom =
	(typeof jellyfishScheduleActionStartFromValues)[number]

export type JellyfishScheduleAction = {
	type: JellyfishScheduleActionType
	startFrom: JellyfishScheduleActionStartFrom
	hour: number
	minute: number
	patternFile?: string
	zones: Array<string>
}

export type JellyfishScheduleEvent = {
	label?: string
	days: Array<string>
	actions: Array<JellyfishScheduleAction>
}

export function isJellyfishCalendarScheduleDay(day: string) {
	if (!/^\d{8}$/.test(day)) return false
	const year = Number(day.slice(0, 4))
	const month = Number(day.slice(4, 6))
	const dayOfMonth = Number(day.slice(6, 8))
	const date = new Date(Date.UTC(year, month - 1, dayOfMonth))
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === dayOfMonth
	)
}

export type JellyfishProbeDiagnostic = {
	host: string
	port: number
	matched: boolean
	hostname: string | null
	response: Record<string, unknown> | null
	error: string | null
}

export type JellyfishSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	portOpenCount: number
	jellyfishMatches: number
}

export type JellyfishDiscoveryDiagnostics = {
	protocol: 'json' | 'subnet'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	probeResults: Array<JellyfishProbeDiagnostic>
	subnetProbe: JellyfishSubnetProbeSummary | null
}
