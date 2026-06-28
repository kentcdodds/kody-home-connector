import {
	isJellyfishCalendarScheduleDay,
	jellyfishDailyScheduleDays,
	type JellyfishDiscoveredController,
	jellyfishDefaultPort,
	jellyfishScheduleActionStartFromValues,
	jellyfishScheduleActionTypes,
	type JellyfishScheduleType,
} from './types.ts'

const mockHost = 'jellyfish-f348.mock.local'
const mockControllerId = 'jellyfish-f348-local'
const mockHostname = 'JellyFish-F348.local'
const mockName = 'JellyFish-F348'

const mockPatternFileData = {
	colors: [0, 0, 255],
	spaceBetweenPixels: 1,
	effectBetweenPixels: 'No Color Transform',
	type: 'Color',
	skip: 1,
	numOfLeds: 1,
	runData: {
		speed: 1,
		brightness: 100,
		effect: 'No Effect',
		effectValue: 0,
		rgbAdj: [100, 100, 100],
	},
	direction: 'Center',
}

let mockLastRunPattern: Record<string, unknown> | null = null
let mockDailySchedule: Array<Record<string, unknown>> = []
let mockCalendarSchedule: Array<Record<string, unknown>> = []

export function resetMockJellyfishState() {
	mockLastRunPattern = null
	mockDailySchedule = [
		{
			label: 'Daily Accent',
			days: ['M', 'T', 'W', 'TH', 'F', 'SA', 'S'],
			actions: [
				{
					type: 'RUN',
					startFrom: 'sunset',
					hour: 0,
					minute: 0,
					patternFile: 'Colors/Blue',
					zones: ['Zone'],
				},
			],
		},
	]
	mockCalendarSchedule = [
		{
			label: 'Brooke Birthday',
			days: ['20260628'],
			actions: [
				{
					type: 'RUN',
					startFrom: 'time',
					hour: 18,
					minute: 0,
					patternFile: 'Christmas/Christmas Tree',
					zones: ['Zone'],
				},
			],
		},
	]
}

export function setMockJellyfishScheduleState(input: {
	daily?: Array<Record<string, unknown>>
	calendar?: Array<Record<string, unknown>>
}) {
	if (input.daily) mockDailySchedule = structuredClone(input.daily)
	if (input.calendar) mockCalendarSchedule = structuredClone(input.calendar)
}

export function isMockJellyfishHost(host: string) {
	return host.endsWith('.mock.local')
}

export function getMockJellyfishDiscoveryPayload() {
	const now = new Date().toISOString()
	return {
		controllers: [
			{
				controllerId: mockControllerId,
				name: mockName,
				hostname: mockHostname,
				host: mockHost,
				port: jellyfishDefaultPort,
				firmwareVersion: null,
				lastSeenAt: now,
				rawDiscovery: {
					mock: true,
					source: 'json',
				},
			} satisfies JellyfishDiscoveredController,
		],
	}
}

function buildZonesResponse() {
	return {
		cmd: 'fromCtlr',
		save: true,
		zones: {
			Zone: {
				numPixels: 755,
				portMap: [
					{
						ctlrName: mockHostname,
						phyEndIdx: 0,
						phyPort: 2,
						phyStartIdx: 124,
						zoneRGBStartIdx: 0,
					},
					{
						ctlrName: mockHostname,
						phyEndIdx: 274,
						phyPort: 4,
						phyStartIdx: 0,
						zoneRGBStartIdx: 125,
					},
					{
						ctlrName: mockHostname,
						phyEndIdx: 354,
						phyPort: 8,
						phyStartIdx: 0,
						zoneRGBStartIdx: 400,
					},
				],
			},
		},
	}
}

function buildPatternListResponse() {
	return {
		cmd: 'fromCtlr',
		patternFileList: [
			{ folders: 'Christmas', name: '', readOnly: false },
			{ folders: 'Christmas', name: 'Christmas Tree', readOnly: true },
			{ folders: 'Colors', name: '', readOnly: false },
			{ folders: 'Colors', name: 'Blue', readOnly: true },
		],
	}
}

function buildPatternFileDataResponse(folder: string, name: string) {
	return {
		cmd: 'fromCtlr',
		patternFileData: {
			folders: folder,
			name,
			jsonData: JSON.stringify(mockPatternFileData),
		},
	}
}

function buildScheduleResponse(
	key: 'scheduleDaily' | 'scheduleCalendar',
	events: Array<Record<string, unknown>>,
) {
	return {
		cmd: 'fromCtlr',
		[key]: structuredClone(events),
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertStringArray(input: unknown, path: string) {
	if (!Array.isArray(input)) {
		throw new Error(`Mock JellyFish schedule ${path} must be an array.`)
	}
	for (const [index, value] of input.entries()) {
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(
				`Mock JellyFish schedule ${path}[${String(index)}] must be a non-empty string.`,
			)
		}
	}
	return input.map((value) => value.trim())
}

function assertScheduleDays(
	input: unknown,
	scheduleType: JellyfishScheduleType,
) {
	const days = assertStringArray(input, 'days')
	if (scheduleType === 'daily') {
		const validDays = new Set<string>(jellyfishDailyScheduleDays)
		const invalidDays = days.filter((day) => !validDays.has(day.toUpperCase()))
		if (invalidDays.length > 0) {
			throw new Error(
				`Invalid mock JellyFish daily schedule day(s): ${invalidDays.join(', ')}.`,
			)
		}
		return
	}
	const invalidDays = days.filter((day) => !isJellyfishCalendarScheduleDay(day))
	if (invalidDays.length > 0) {
		throw new Error(
			`Invalid mock JellyFish calendar schedule day(s): ${invalidDays.join(', ')}.`,
		)
	}
}

function assertScheduleAction(input: unknown, path: string) {
	if (!isRecord(input)) {
		throw new Error(`Mock JellyFish schedule ${path} must be an object.`)
	}
	const type = input['type']
	if (
		typeof type !== 'string' ||
		!jellyfishScheduleActionTypes.includes(
			type
				.trim()
				.toUpperCase() as (typeof jellyfishScheduleActionTypes)[number],
		)
	) {
		throw new Error(`Invalid mock JellyFish schedule ${path} type.`)
	}
	const startFrom = input['startFrom']
	if (
		typeof startFrom !== 'string' ||
		!jellyfishScheduleActionStartFromValues.includes(
			startFrom
				.trim()
				.toLowerCase() as (typeof jellyfishScheduleActionStartFromValues)[number],
		)
	) {
		throw new Error(`Invalid mock JellyFish schedule ${path} startFrom.`)
	}
	const hour = input['hour']
	const minute = input['minute']
	if (typeof hour !== 'number' || !Number.isInteger(hour)) {
		throw new Error(`Mock JellyFish schedule ${path} hour must be an integer.`)
	}
	if (typeof minute !== 'number' || !Number.isInteger(minute)) {
		throw new Error(
			`Mock JellyFish schedule ${path} minute must be an integer.`,
		)
	}
	if (startFrom.trim().toLowerCase() === 'time') {
		if (hour < 0 || hour > 23) {
			throw new Error(`Mock JellyFish schedule ${path} hour is out of range.`)
		}
		if (minute < 0 || minute > 59) {
			throw new Error(`Mock JellyFish schedule ${path} minute is out of range.`)
		}
	} else if (hour !== 0 || minute < -55 || minute > 55 || minute % 5 !== 0) {
		throw new Error(
			`Mock JellyFish schedule ${path} sunrise/sunset timing is invalid.`,
		)
	}
	if (type.trim().toUpperCase() === 'RUN') {
		const patternFile = input['patternFile']
		if (typeof patternFile !== 'string' || !patternFile.trim()) {
			throw new Error(
				`Mock JellyFish schedule ${path} RUN action requires patternFile.`,
			)
		}
	} else if (
		input['patternFile'] != null &&
		typeof input['patternFile'] !== 'string'
	) {
		throw new Error(`Mock JellyFish schedule ${path} patternFile is invalid.`)
	}
	assertStringArray(input['zones'], `${path}.zones`)
}

function normalizeMockScheduleEvents(
	events: unknown,
	scheduleType: JellyfishScheduleType,
) {
	if (!Array.isArray(events)) {
		throw new Error(
			`Mock JellyFish ${scheduleType} schedule events must be an array.`,
		)
	}
	for (const [index, event] of events.entries()) {
		if (!isRecord(event)) {
			throw new Error(
				`Mock JellyFish ${scheduleType} schedule event ${String(index)} must be an object.`,
			)
		}
		if (event['label'] != null && typeof event['label'] !== 'string') {
			throw new Error(
				`Mock JellyFish ${scheduleType} schedule event ${String(index)} label must be a string.`,
			)
		}
		assertScheduleDays(event['days'], scheduleType)
		if (!Array.isArray(event['actions'])) {
			throw new Error(
				`Mock JellyFish ${scheduleType} schedule event ${String(index)} actions must be an array.`,
			)
		}
		for (const [actionIndex, action] of event['actions'].entries()) {
			assertScheduleAction(
				action,
				`event ${String(index)} action ${String(actionIndex)}`,
			)
		}
	}
	return structuredClone(events) as Array<Record<string, unknown>>
}

export async function sendMockJellyfishCommand(
	host: string,
	command: Record<string, unknown>,
) {
	if (!isMockJellyfishHost(host)) {
		throw new Error(`Unknown mock JellyFish host "${host}".`)
	}

	const get = command['get']
	if (
		command['cmd'] === 'toCtlrGet' &&
		Array.isArray(get) &&
		Array.isArray(get[0])
	) {
		const request = get[0] as Array<unknown>
		const resource = typeof request[0] === 'string' ? request[0] : ''
		switch (resource) {
			case 'zones':
				return buildZonesResponse()
			case 'patternFileList':
				return buildPatternListResponse()
			case 'patternFileData': {
				const folder = typeof request[1] === 'string' ? request[1] : 'Colors'
				const name = typeof request[2] === 'string' ? request[2] : 'Blue'
				return buildPatternFileDataResponse(folder, name)
			}
			case 'scheduleDaily':
				return buildScheduleResponse('scheduleDaily', mockDailySchedule)
			case 'scheduleCalendar':
				return buildScheduleResponse('scheduleCalendar', mockCalendarSchedule)
			default:
				throw new Error(
					`Unsupported mock JellyFish get resource "${resource}".`,
				)
		}
	}

	if (command['cmd'] === 'toCtlrSet') {
		const schedule = command['schedule']
		const events = command['events']
		if (schedule === 'daily') {
			mockDailySchedule = normalizeMockScheduleEvents(events, 'daily')
			return buildScheduleResponse('scheduleDaily', mockDailySchedule)
		}
		if (schedule === 'calendar') {
			mockCalendarSchedule = normalizeMockScheduleEvents(events, 'calendar')
			return buildScheduleResponse('scheduleCalendar', mockCalendarSchedule)
		}
	}

	const runPattern = command['runPattern']
	if (
		command['cmd'] === 'toCtlrSet' &&
		runPattern &&
		typeof runPattern === 'object' &&
		!Array.isArray(runPattern)
	) {
		mockLastRunPattern = structuredClone(runPattern as Record<string, unknown>)
		return {
			cmd: 'fromCtlr',
			runPattern: mockLastRunPattern,
		}
	}

	throw new Error('Unsupported mock JellyFish command.')
}
