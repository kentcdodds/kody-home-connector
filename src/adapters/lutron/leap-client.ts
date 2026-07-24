import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import {
	type LutronArea,
	type LutronButton,
	type LutronControlStation,
	type LutronPersistedProcessor,
	type LutronVirtualButton,
	type LutronZone,
	type LutronZoneStatus,
	type LutronInventory,
	type LutronAssociatedGangedDevice,
} from './types.ts'
import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'

type LeapResponse = {
	CommuniqueType?: string
	Header?: {
		StatusCode?: string
		Url?: string
		ClientTag?: string
		MessageBodyType?: string
	}
	Body?: Record<string, unknown>
}

export class LutronLeapResponseError extends Error {
	readonly action: string
	readonly statusCode: string
	readonly responseBody: Record<string, unknown> | undefined
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext

	constructor(input: {
		action: string
		statusCode: string
		responseBody: Record<string, unknown> | undefined
	}) {
		const details = input.responseBody
			? JSON.stringify(input.responseBody)
			: input.statusCode
		super(
			`Lutron ${input.action} failed with ${input.statusCode || 'unknown status'}: ${details}`,
		)
		this.name = 'LutronLeapResponseError'
		this.action = input.action
		this.statusCode = input.statusCode
		this.responseBody = input.responseBody
		const failureCode = classifyExpectedLeapFailure(input)
		if (failureCode) {
			this.homeConnectorCaptureContext = {
				shouldCapture: false,
				tags: {
					connector_vendor: 'lutron',
					lutron_failure_code: failureCode,
				},
			}
		}
	}
}

export class LutronInvalidZoneIdError extends Error {
	readonly zoneId: string
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext

	constructor(zoneId: string) {
		super(
			`Lutron zone id "${zoneId}" is invalid. Pass a numeric zone id from lutron_get_inventory (for example "495"), not a button/device href.`,
		)
		this.name = 'LutronInvalidZoneIdError'
		this.zoneId = zoneId
		this.homeConnectorCaptureContext = {
			shouldCapture: false,
			tags: {
				connector_vendor: 'lutron',
				lutron_failure_code: 'invalid_zone_id',
			},
		}
	}
}

export class LutronUnsupportedZoneCommandError extends Error {
	readonly zoneId: string
	readonly controlType: string
	readonly command: string
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext

	constructor(input: {
		zoneId: string
		controlType: string
		command: string
		message: string
	}) {
		super(input.message)
		this.name = 'LutronUnsupportedZoneCommandError'
		this.zoneId = input.zoneId
		this.controlType = input.controlType
		this.command = input.command
		this.homeConnectorCaptureContext = {
			shouldCapture: false,
			tags: {
				connector_vendor: 'lutron',
				lutron_failure_code: 'unsupported_zone_command',
				lutron_control_type: input.controlType,
			},
		}
	}
}

function isUnsupportedGoToLevelResponse(input: {
	action: string
	statusCode: string
	responseBody: Record<string, unknown> | undefined
}) {
	return (
		input.action.startsWith('zone ') &&
		input.action.endsWith(' level set') &&
		input.statusCode.startsWith('405') &&
		input.responseBody?.['Message'] ===
			'GoToLevel not supported for the specified ZoneType'
	)
}

function isUnsupportedRequestResponse(input: {
	statusCode: string
	responseBody: Record<string, unknown> | undefined
}) {
	return (
		input.statusCode.startsWith('400') &&
		input.responseBody?.['Message'] === 'This request is not supported'
	)
}

function isInvalidCredentialsResponse(input: {
	action: string
	statusCode: string
}) {
	return input.action === 'login' && input.statusCode.startsWith('401')
}

function classifyExpectedLeapFailure(input: {
	action: string
	statusCode: string
	responseBody: Record<string, unknown> | undefined
}): string | null {
	if (isUnsupportedGoToLevelResponse(input)) {
		return 'unsupported_zone_level'
	}
	if (isUnsupportedRequestResponse(input)) {
		return 'unsupported_request'
	}
	if (isInvalidCredentialsResponse(input)) {
		return 'invalid_credentials'
	}
	return null
}

export function isLutronUnsupportedZoneLevelError(
	error: unknown,
): error is LutronLeapResponseError | LutronUnsupportedZoneCommandError {
	return (
		(error instanceof LutronLeapResponseError &&
			isUnsupportedGoToLevelResponse(error)) ||
		error instanceof LutronUnsupportedZoneCommandError
	)
}

export function isLutronUnsupportedRequestError(
	error: unknown,
): error is LutronLeapResponseError {
	return (
		error instanceof LutronLeapResponseError &&
		isUnsupportedRequestResponse(error)
	)
}

export function isLutronInvalidCredentialsError(
	error: unknown,
): error is LutronLeapResponseError {
	return (
		error instanceof LutronLeapResponseError &&
		isInvalidCredentialsResponse(error)
	)
}

export function isLutronInvalidZoneIdError(
	error: unknown,
): error is LutronInvalidZoneIdError {
	return error instanceof LutronInvalidZoneIdError
}

export function isLutronExpectedClientError(error: unknown): boolean {
	return (
		isLutronUnsupportedZoneLevelError(error) ||
		isLutronUnsupportedRequestError(error) ||
		isLutronInvalidZoneIdError(error) ||
		isLutronInvalidCredentialsError(error)
	)
}

export function normalizeLutronZoneId(zoneId: string): string {
	const trimmed = zoneId.trim()
	const hrefMatch = /^\/zone\/([^/]+)\/?$/i.exec(trimmed)
	const candidate = hrefMatch?.[1] ?? trimmed
	if (!/^\d+$/.test(candidate)) {
		throw new LutronInvalidZoneIdError(zoneId)
	}
	return candidate
}

type LutronZoneLevelCommand = {
	commandType: string
	body: Record<string, unknown>
}

export function buildLutronZoneLevelCommand(input: {
	zoneId: string
	controlType: string
	level: number
	status: LutronZoneStatus | null
}): LutronZoneLevelCommand {
	const controlType = input.controlType.trim() || 'Unknown'
	const level = Math.max(0, Math.min(100, input.level))

	switch (controlType) {
		case 'Dimmed':
			return {
				commandType: 'GoToLevel',
				body: {
					Command: {
						CommandType: 'GoToLevel',
						Parameter: [
							{
								Type: 'Level',
								Value: level,
							},
						],
					},
				},
			}
		case 'SpectrumTune':
		case 'ColorTune': {
			const spectrumParameters: Record<string, unknown> = {
				Level: level,
			}
			if (typeof input.status?.vibrancy === 'number') {
				spectrumParameters['Vibrancy'] = input.status.vibrancy
			}
			return {
				commandType: 'GoToSpectrumTuningLevel',
				body: {
					Command: {
						CommandType: 'GoToSpectrumTuningLevel',
						SpectrumTuningLevelParameters: spectrumParameters,
					},
				},
			}
		}
		case 'WhiteTune': {
			const kelvin = input.status?.whiteTuningKelvin
			if (typeof kelvin !== 'number') {
				throw new LutronUnsupportedZoneCommandError({
					zoneId: input.zoneId,
					controlType,
					command: 'GoToLevel',
					message: `Lutron zone ${input.zoneId} is WhiteTune and cannot use GoToLevel. Use lutron_set_zone_white_tuning with an explicit Kelvin value.`,
				})
			}
			return {
				commandType: 'GoToWhiteTuningLevel',
				body: {
					Command: {
						CommandType: 'GoToWhiteTuningLevel',
						WhiteTuningLevelParameters: {
							Level: level,
							WhiteTuningLevel: {
								Kelvin: kelvin,
							},
						},
					},
				},
			}
		}
		case 'Switched':
			return {
				commandType: 'GoToSwitchedLevel',
				body: {
					Command: {
						CommandType: 'GoToSwitchedLevel',
						SwitchedLevelParameters: {
							SwitchedLevel: level > 0 ? 'On' : 'Off',
						},
					},
				},
			}
		case 'Shade':
			return {
				commandType: 'GoToShadeLevel',
				body: {
					Command: {
						CommandType: 'GoToShadeLevel',
						ShadeLevelParameters: {
							Level: level,
						},
					},
				},
			}
		default:
			throw new LutronUnsupportedZoneCommandError({
				zoneId: input.zoneId,
				controlType,
				command: 'GoToLevel',
				message: `Lutron zone ${input.zoneId} has ControlType "${controlType}", which does not support level-set via lutron_set_zone_level.`,
			})
	}
}

const LEAP_SOCKET_TIMEOUT_MS = 5_000

type LutronCredentials = {
	username: string
	password: string
}

type LeapClient = {
	login(credentials: LutronCredentials): Promise<void>
	read(url: string): Promise<LeapResponse>
	create(url: string, body: Record<string, unknown>): Promise<LeapResponse>
	close(): Promise<void>
}

type LutronInventoryNode = {
	area: LutronArea
}

function createTlsSocket(input: { host: string; port: number }) {
	return new Promise<TLSSocket>((resolve, reject) => {
		const socket = tlsConnect({
			host: input.host,
			port: input.port,
			rejectUnauthorized: false,
			timeout: LEAP_SOCKET_TIMEOUT_MS,
		})

		socket.once('secureConnect', () => {
			socket.removeAllListeners('error')
			socket.removeAllListeners('timeout')
			resolve(socket)
		})

		socket.once('error', (error) => {
			socket.destroy()
			reject(error)
		})

		socket.once('timeout', () => {
			socket.destroy()
			reject(
				new Error(
					`Lutron TLS connection to ${input.host}:${String(input.port)} timed out.`,
				),
			)
		})
	})
}

const pendingLeapBuffers = new WeakMap<TLSSocket, Buffer>()

function setPendingBuffer(socket: TLSSocket, buffer: Buffer) {
	if (buffer.length === 0) {
		pendingLeapBuffers.delete(socket)
		return
	}
	pendingLeapBuffers.set(socket, buffer)
}

function readNextLine(socket: TLSSocket) {
	return new Promise<string>((resolve, reject) => {
		let buffer = pendingLeapBuffers.get(socket) ?? Buffer.alloc(0)
		const initialNewlineIndex = buffer.indexOf(0x0a)
		if (initialNewlineIndex !== -1) {
			const lineBuffer = buffer.subarray(0, initialNewlineIndex)
			const remainder = buffer.subarray(initialNewlineIndex + 1)
			setPendingBuffer(socket, remainder)
			resolve(lineBuffer.toString('utf8').trim())
			return
		}

		function cleanup() {
			socket.off('data', onData)
			socket.off('error', onError)
			socket.off('close', onClose)
			socket.off('timeout', onTimeout)
		}

		function finish(result: Buffer, remainder?: Buffer) {
			cleanup()
			if (remainder) {
				setPendingBuffer(socket, remainder)
			} else {
				setPendingBuffer(socket, Buffer.alloc(0))
			}
			resolve(result.toString('utf8').trim())
		}

		function onData(chunk: Buffer) {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
			const newlineIndex = buffer.indexOf(0x0a)
			if (newlineIndex !== -1) {
				const lineBuffer = buffer.subarray(0, newlineIndex)
				const remainder = buffer.subarray(newlineIndex + 1)
				finish(lineBuffer, remainder)
			}
		}

		function onError(error: Error) {
			cleanup()
			reject(error)
		}

		function onClose() {
			finish(buffer)
		}

		function onTimeout() {
			cleanup()
			socket.destroy()
			reject(
				new Error(
					`Lutron LEAP read timed out after ${LEAP_SOCKET_TIMEOUT_MS}ms.`,
				),
			)
		}

		socket.setTimeout(LEAP_SOCKET_TIMEOUT_MS)
		socket.on('data', onData)
		socket.once('error', onError)
		socket.once('close', onClose)
		socket.once('timeout', onTimeout)
	})
}

async function sendLeapMessage(
	socket: TLSSocket,
	input: {
		communiqueType: 'ReadRequest' | 'UpdateRequest' | 'CreateRequest'
		url: string
		body?: Record<string, unknown>
	},
) {
	const request = {
		CommuniqueType: input.communiqueType,
		Header: {
			ClientTag: randomUUID(),
			Url: input.url,
		},
		...(input.body ? { Body: input.body } : {}),
	}
	socket.write(`${JSON.stringify(request)}\n`)
	const raw = await readNextLine(socket)
	if (!raw) {
		throw new Error(`Lutron LEAP request to ${input.url} returned no response.`)
	}

	const response = JSON.parse(raw) as LeapResponse
	return response
}

function extractResourceId(href: string) {
	return href.split('/').filter(Boolean).at(-1) ?? href
}

function normalizeAreaPath(path: Array<string>) {
	return path.filter((segment) => segment.length > 0)
}

function getStatusCode(response: LeapResponse) {
	return response.Header?.StatusCode ?? ''
}

function isNoContent(response: LeapResponse) {
	return getStatusCode(response).startsWith('204')
}

function assertSuccessfulResponse(response: LeapResponse, action: string) {
	const statusCode = getStatusCode(response)
	if (
		statusCode.startsWith('200') ||
		statusCode.startsWith('201') ||
		statusCode.startsWith('204')
	) {
		return
	}

	throw new LutronLeapResponseError({
		action,
		statusCode,
		responseBody: response.Body,
	})
}

export async function createLutronLeapClient(
	processor: Pick<LutronPersistedProcessor, 'host' | 'address' | 'leapPort'>,
): Promise<LeapClient> {
	// Prefer the raw IP to avoid .local mDNS lookups in worker runtimes.
	const connectionHost = processor.address ?? processor.host
	const socket = await createTlsSocket({
		host: connectionHost,
		port: processor.leapPort,
	})

	return {
		async login(credentials) {
			const response = await sendLeapMessage(socket, {
				communiqueType: 'UpdateRequest',
				url: '/login',
				body: {
					Login: {
						ContextType: 'Application',
						LoginId: credentials.username,
						Password: credentials.password,
					},
				},
			})
			assertSuccessfulResponse(response, 'login')
		},
		async read(url) {
			return await sendLeapMessage(socket, {
				communiqueType: 'ReadRequest',
				url,
			})
		},
		async create(url, body) {
			return await sendLeapMessage(socket, {
				communiqueType: 'CreateRequest',
				url,
				body,
			})
		},
		async close() {
			await new Promise<void>((resolve) => {
				socket.end(() => resolve())
			})
		},
	}
}

function mapZoneStatus(response: LeapResponse): LutronZoneStatus | null {
	const zoneStatus =
		(response.Body?.['ZoneStatus'] as Record<string, unknown> | undefined) ??
		null
	if (!zoneStatus) return null

	const colorTuningStatus =
		(zoneStatus['ColorTuningStatus'] as Record<string, unknown> | undefined) ??
		{}
	const hsv =
		(colorTuningStatus['HSVTuningLevel'] as
			| Record<string, unknown>
			| undefined) ?? {}
	const white =
		(colorTuningStatus['WhiteTuningLevel'] as
			| Record<string, unknown>
			| undefined) ?? {}

	return {
		level: typeof zoneStatus['Level'] === 'number' ? zoneStatus['Level'] : null,
		switchedLevel:
			zoneStatus['SwitchedLevel'] === 'On' ||
			zoneStatus['SwitchedLevel'] === 'Off'
				? zoneStatus['SwitchedLevel']
				: null,
		vibrancy:
			typeof zoneStatus['Vibrancy'] === 'number'
				? zoneStatus['Vibrancy']
				: null,
		whiteTuningKelvin:
			typeof white['Kelvin'] === 'number' ? white['Kelvin'] : null,
		hue: typeof hsv['Hue'] === 'number' ? hsv['Hue'] : null,
		saturation:
			typeof hsv['Saturation'] === 'number' ? hsv['Saturation'] : null,
		statusAccuracy:
			typeof zoneStatus['StatusAccuracy'] === 'string'
				? zoneStatus['StatusAccuracy']
				: null,
		zoneLockState:
			typeof zoneStatus['ZoneLockState'] === 'string'
				? zoneStatus['ZoneLockState']
				: null,
	}
}

function mapLedState(response: LeapResponse) {
	const ledStatus =
		(response.Body?.['LEDStatus'] as Record<string, unknown> | undefined) ??
		null
	if (!ledStatus) return null
	return ledStatus['State'] === 'On' || ledStatus['State'] === 'Off'
		? ledStatus['State']
		: 'Unknown'
}

function mapAssociatedGangedDevices(
	devices: Array<Record<string, unknown>>,
): Array<LutronAssociatedGangedDevice> {
	return devices.flatMap((entry) => {
		const device =
			(entry['Device'] as Record<string, unknown> | undefined) ?? null
		if (!device || typeof device['href'] !== 'string') return []
		return [
			{
				deviceId: extractResourceId(device['href']),
				href: device['href'],
				deviceType:
					typeof device['DeviceType'] === 'string'
						? device['DeviceType']
						: 'Unknown',
				addressedState:
					typeof device['AddressedState'] === 'string'
						? device['AddressedState']
						: null,
				gangPosition:
					typeof entry['GangPosition'] === 'number'
						? entry['GangPosition']
						: null,
			},
		]
	})
}

async function fetchLedState(client: LeapClient, ledHref: string | null) {
	if (!ledHref) return null
	const response = await client.read(`${ledHref}/status`)
	if (isNoContent(response)) return null
	const statusCode = getStatusCode(response)
	if (
		isUnsupportedRequestResponse({
			statusCode,
			responseBody: response.Body,
		})
	) {
		return null
	}
	assertSuccessfulResponse(response, `${ledHref} status read`)
	return mapLedState(response)
}

async function buildAreaTree(
	client: LeapClient,
	processorId: string,
): Promise<Array<LutronArea>> {
	const rootResponse = await client.read('/area/rootarea')
	assertSuccessfulResponse(rootResponse, 'root area read')

	const rootArea =
		(rootResponse.Body?.['Area'] as Record<string, unknown> | undefined) ?? null
	if (!rootArea || typeof rootArea['href'] !== 'string') {
		throw new Error(
			'Lutron root area response did not include an Area payload.',
		)
	}

	const rootId = extractResourceId(rootArea['href'])
	const rootName =
		typeof rootArea['Name'] === 'string' ? rootArea['Name'] : rootId
	const areas = new Map<string, LutronArea>()
	const queue: Array<LutronInventoryNode> = [
		{
			area: {
				processorId,
				areaId: rootId,
				href: rootArea['href'],
				name: rootName,
				parentHref: null,
				parentAreaId: null,
				isLeaf: Boolean(rootArea['IsLeaf']),
				path: [rootName],
			},
		},
	]

	while (queue.length > 0) {
		const current = queue.shift()!.area
		areas.set(current.areaId, current)
		const response = await client.read(`${current.href}/childarea/summary`)
		if (isNoContent(response)) continue
		assertSuccessfulResponse(response, `${current.href} child area read`)
		const summaries =
			(response.Body?.['AreaSummaries'] as
				| Array<Record<string, unknown>>
				| undefined) ?? []

		for (const summary of summaries) {
			if (typeof summary['href'] !== 'string') continue
			const childId = extractResourceId(summary['href'])
			const childName =
				typeof summary['Name'] === 'string' ? summary['Name'] : childId
			const childArea: LutronArea = {
				processorId,
				areaId: childId,
				href: summary['href'],
				name: childName,
				parentHref: current.href,
				parentAreaId: current.areaId,
				isLeaf: Boolean(summary['IsLeaf']),
				path: normalizeAreaPath([...current.path, childName]),
			}
			queue.push({ area: childArea })
		}
	}

	return [...areas.values()].sort((left, right) =>
		left.path.join('/').localeCompare(right.path.join('/')),
	)
}

async function buildZones(
	client: LeapClient,
	processorId: string,
	areas: Array<LutronArea>,
): Promise<Array<LutronZone>> {
	const zones: Array<LutronZone> = []

	for (const area of areas) {
		const response = await client.read(`${area.href}/associatedzone`)
		if (isNoContent(response)) continue
		assertSuccessfulResponse(response, `${area.href} associated zone read`)
		const entries =
			(response.Body?.['Zones'] as
				| Array<Record<string, unknown>>
				| undefined) ?? []

		for (const zone of entries) {
			if (typeof zone['href'] !== 'string') continue
			const statusResponse = await client.read(`${zone['href']}/status`)
			assertSuccessfulResponse(statusResponse, `${zone['href']} status read`)
			zones.push({
				processorId,
				areaId: area.areaId,
				areaName: area.name,
				areaPath: area.path,
				zoneId: extractResourceId(zone['href']),
				href: zone['href'],
				name:
					typeof zone['Name'] === 'string'
						? zone['Name']
						: extractResourceId(zone['href']),
				controlType:
					typeof zone['ControlType'] === 'string'
						? zone['ControlType']
						: 'Unknown',
				categoryType:
					typeof (zone['Category'] as Record<string, unknown> | undefined)?.[
						'Type'
					] === 'string'
						? ((zone['Category'] as Record<string, unknown>)['Type'] as string)
						: null,
				isLight: Boolean(
					(zone['Category'] as Record<string, unknown> | undefined)?.[
						'IsLight'
					],
				),
				availableControlTypes: Array.isArray(zone['AvailableControlTypes'])
					? zone['AvailableControlTypes'].filter(
							(entry): entry is string => typeof entry === 'string',
						)
					: [],
				sortOrder:
					typeof zone['SortOrder'] === 'number' ? zone['SortOrder'] : null,
				status: mapZoneStatus(statusResponse),
			})
		}
	}

	return zones.sort(
		(left, right) =>
			left.areaPath.join('/').localeCompare(right.areaPath.join('/')) ||
			(left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
				(right.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
			left.name.localeCompare(right.name),
	)
}

async function buildControlStations(
	client: LeapClient,
	processorId: string,
	areas: Array<LutronArea>,
): Promise<Array<LutronControlStation>> {
	const stations: Array<LutronControlStation> = []

	for (const area of areas) {
		const response = await client.read(`${area.href}/associatedcontrolstation`)
		if (isNoContent(response)) continue
		assertSuccessfulResponse(
			response,
			`${area.href} associated control station read`,
		)
		const entries =
			(response.Body?.['ControlStations'] as
				| Array<Record<string, unknown>>
				| undefined) ?? []

		for (const station of entries) {
			if (typeof station['href'] !== 'string') continue
			stations.push({
				processorId,
				areaId: area.areaId,
				areaName: area.name,
				areaPath: area.path,
				controlStationId: extractResourceId(station['href']),
				href: station['href'],
				name:
					typeof station['Name'] === 'string'
						? station['Name']
						: extractResourceId(station['href']),
				sortOrder:
					typeof station['SortOrder'] === 'number'
						? station['SortOrder']
						: null,
				devices: mapAssociatedGangedDevices(
					(Array.isArray(station['AssociatedGangedDevices'])
						? station['AssociatedGangedDevices']
						: []) as Array<Record<string, unknown>>,
				),
			})
		}
	}

	return stations.sort(
		(left, right) =>
			left.areaPath.join('/').localeCompare(right.areaPath.join('/')) ||
			(left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
				(right.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
			left.name.localeCompare(right.name),
	)
}

async function buildButtons(
	client: LeapClient,
	processorId: string,
	controlStations: Array<LutronControlStation>,
): Promise<Array<LutronButton>> {
	const buttons: Array<LutronButton> = []

	for (const station of controlStations) {
		for (const device of station.devices) {
			const deviceResponse = await client.read(device.href)
			assertSuccessfulResponse(deviceResponse, `${device.href} device read`)
			const deviceBody =
				(deviceResponse.Body?.['Device'] as
					| Record<string, unknown>
					| undefined) ?? null
			if (!deviceBody) continue

			const buttonGroupResponse = await client.read(
				`${device.href}/buttongroup/expanded`,
			)
			if (isNoContent(buttonGroupResponse)) continue
			assertSuccessfulResponse(
				buttonGroupResponse,
				`${device.href} button group expanded read`,
			)
			const groups =
				(buttonGroupResponse.Body?.['ButtonGroupsExpanded'] as
					| Array<Record<string, unknown>>
					| undefined) ?? []

			for (const group of groups) {
				if (typeof group['href'] !== 'string') continue
				const entries =
					(group['Buttons'] as Array<Record<string, unknown>> | undefined) ?? []
				for (const button of entries) {
					if (typeof button['href'] !== 'string') continue
					const ledHref =
						typeof (
							button['AssociatedLED'] as Record<string, unknown> | undefined
						)?.['href'] === 'string'
							? ((button['AssociatedLED'] as Record<string, unknown>)[
									'href'
								] as string)
							: null
					buttons.push({
						processorId,
						areaId: station.areaId,
						areaName: station.areaName,
						areaPath: station.areaPath,
						keypadDeviceId: device.deviceId,
						keypadHref: device.href,
						keypadName:
							typeof deviceBody['Name'] === 'string'
								? deviceBody['Name']
								: station.name,
						keypadModelNumber:
							typeof deviceBody['ModelNumber'] === 'string'
								? deviceBody['ModelNumber']
								: null,
						keypadSerialNumber:
							typeof deviceBody['SerialNumber'] === 'number'
								? String(deviceBody['SerialNumber'])
								: typeof deviceBody['SerialNumber'] === 'string'
									? deviceBody['SerialNumber']
									: null,
						buttonGroupId: extractResourceId(group['href']),
						buttonId: extractResourceId(button['href']),
						href: button['href'],
						buttonNumber:
							typeof button['ButtonNumber'] === 'number'
								? button['ButtonNumber']
								: 0,
						name:
							typeof button['Name'] === 'string'
								? button['Name']
								: extractResourceId(button['href']),
						label:
							typeof (
								button['Engraving'] as Record<string, unknown> | undefined
							)?.['Text'] === 'string'
								? (
										(button['Engraving'] as Record<string, unknown>)[
											'Text'
										] as string
									)
										.replaceAll('\n', ' ')
										.trim() ||
									(typeof button['Name'] === 'string'
										? button['Name']
										: extractResourceId(button['href']))
								: typeof button['Name'] === 'string'
									? button['Name']
									: extractResourceId(button['href']),
						programmingModelType:
							typeof (
								button['ProgrammingModel'] as
									| Record<string, unknown>
									| undefined
							)?.['ProgrammingModelType'] === 'string'
								? ((button['ProgrammingModel'] as Record<string, unknown>)[
										'ProgrammingModelType'
									] as string)
								: null,
						ledId: ledHref ? extractResourceId(ledHref) : null,
						ledHref,
						ledState: await fetchLedState(client, ledHref),
					})
				}
			}
		}
	}

	return buttons.sort(
		(left, right) =>
			left.areaPath.join('/').localeCompare(right.areaPath.join('/')) ||
			left.keypadName.localeCompare(right.keypadName) ||
			left.buttonNumber - right.buttonNumber,
	)
}

async function buildVirtualButtons(
	client: LeapClient,
	processorId: string,
): Promise<Array<LutronVirtualButton>> {
	const response = await client.read('/virtualbutton')
	if (isNoContent(response)) return []
	assertSuccessfulResponse(response, 'virtual button read')
	const entries =
		(response.Body?.['VirtualButtons'] as
			| Array<Record<string, unknown>>
			| undefined) ?? []
	return entries
		.filter((entry) => typeof entry['href'] === 'string')
		.map((entry) => ({
			processorId,
			virtualButtonId: extractResourceId(entry['href'] as string),
			href: entry['href'] as string,
			name:
				typeof entry['Name'] === 'string'
					? entry['Name']
					: extractResourceId(entry['href'] as string),
			isProgrammed: Boolean(entry['IsProgrammed']),
		}))
}

export async function loadLutronInventory(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
}): Promise<LutronInventory> {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const areas = await buildAreaTree(client, input.processor.processorId)
		const zones = await buildZones(client, input.processor.processorId, areas)
		const controlStations = await buildControlStations(
			client,
			input.processor.processorId,
			areas,
		)
		const buttons = await buildButtons(
			client,
			input.processor.processorId,
			controlStations,
		)
		const virtualButtons = await buildVirtualButtons(
			client,
			input.processor.processorId,
		)
		return {
			processor: input.processor,
			areas,
			zones,
			controlStations,
			buttons,
			virtualButtons,
			sceneButtons: [
				...buttons.map((button) => ({ kind: 'keypad' as const, ...button })),
				...virtualButtons
					.filter((button) => button.isProgrammed)
					.map((button) => ({ kind: 'virtual' as const, ...button })),
			],
		}
	} finally {
		await client.close()
	}
}

export async function authenticateLutronProcessor(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
}) {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
	} finally {
		await client.close()
	}
}

export async function pressLutronButton(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	buttonId: string
}) {
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const response = await client.create(
			`/button/${input.buttonId}/commandprocessor`,
			{
				Command: {
					CommandType: 'PressAndRelease',
				},
			},
		)
		assertSuccessfulResponse(response, `button ${input.buttonId} press`)
		return response
	} finally {
		await client.close()
	}
}

async function readZoneDefinition(
	client: LeapClient,
	zoneId: string,
): Promise<{
	controlType: string
	availableControlTypes: Array<string>
}> {
	const response = await client.read(`/zone/${zoneId}`)
	assertSuccessfulResponse(response, `zone ${zoneId} definition read`)
	const zone =
		(response.Body?.['Zone'] as Record<string, unknown> | undefined) ?? null
	if (!zone) {
		throw new Error(
			`Lutron zone ${zoneId} definition response did not include a Zone payload.`,
		)
	}
	return {
		controlType:
			typeof zone['ControlType'] === 'string' ? zone['ControlType'] : 'Unknown',
		availableControlTypes: Array.isArray(zone['AvailableControlTypes'])
			? zone['AvailableControlTypes'].filter(
					(entry): entry is string => typeof entry === 'string',
				)
			: [],
	}
}

async function readZoneStatus(
	client: LeapClient,
	zoneId: string,
): Promise<LutronZoneStatus | null> {
	const response = await client.read(`/zone/${zoneId}/status`)
	assertSuccessfulResponse(response, `zone ${zoneId} status read`)
	return mapZoneStatus(response)
}

function zoneLevelNeedsStatus(controlType: string) {
	return (
		controlType === 'SpectrumTune' ||
		controlType === 'ColorTune' ||
		controlType === 'WhiteTune'
	)
}

export async function setLutronZoneLevel(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	zoneId: string
	level: number
}) {
	const zoneId = normalizeLutronZoneId(input.zoneId)
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const definition = await readZoneDefinition(client, zoneId)
		const status = zoneLevelNeedsStatus(definition.controlType)
			? await readZoneStatus(client, zoneId)
			: null
		const command = buildLutronZoneLevelCommand({
			zoneId,
			controlType: definition.controlType,
			level: input.level,
			status,
		})
		const response = await client.create(
			`/zone/${zoneId}/commandprocessor`,
			command.body,
		)
		assertSuccessfulResponse(response, `zone ${zoneId} level set`)
		return response
	} finally {
		await client.close()
	}
}

export async function setLutronZoneColor(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	zoneId: string
	hue: number
	saturation: number
	level?: number
	vibrancy?: number
}) {
	const zoneId = normalizeLutronZoneId(input.zoneId)
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const definition = await readZoneDefinition(client, zoneId)
		if (
			definition.controlType !== 'SpectrumTune' &&
			definition.controlType !== 'ColorTune'
		) {
			throw new LutronUnsupportedZoneCommandError({
				zoneId,
				controlType: definition.controlType,
				command: 'GoToSpectrumTuningLevel',
				message: `Lutron zone ${zoneId} has ControlType "${definition.controlType}", which does not support lutron_set_zone_color.`,
			})
		}
		const currentStatus = await readZoneStatus(client, zoneId)
		const response = await client.create(`/zone/${zoneId}/commandprocessor`, {
			Command: {
				CommandType: 'GoToSpectrumTuningLevel',
				SpectrumTuningLevelParameters: {
					Level: input.level ?? currentStatus?.level ?? 100,
					Vibrancy: input.vibrancy ?? currentStatus?.vibrancy ?? 50,
					ColorTuningStatus: {
						HSVTuningLevel: {
							Hue: input.hue,
							Saturation: input.saturation,
						},
					},
				},
			},
		})
		assertSuccessfulResponse(response, `zone ${zoneId} color set`)
		return response
	} finally {
		await client.close()
	}
}

export async function setLutronZoneWhiteTuning(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	zoneId: string
	kelvin: number
	level?: number
}) {
	const zoneId = normalizeLutronZoneId(input.zoneId)
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const definition = await readZoneDefinition(client, zoneId)
		if (
			definition.controlType !== 'WhiteTune' &&
			definition.controlType !== 'SpectrumTune' &&
			definition.controlType !== 'ColorTune'
		) {
			throw new LutronUnsupportedZoneCommandError({
				zoneId,
				controlType: definition.controlType,
				command: 'GoToWhiteTuningLevel',
				message: `Lutron zone ${zoneId} has ControlType "${definition.controlType}", which does not support lutron_set_zone_white_tuning.`,
			})
		}
		const currentStatus = await readZoneStatus(client, zoneId)
		const response = await client.create(`/zone/${zoneId}/commandprocessor`, {
			Command: {
				CommandType: 'GoToWhiteTuningLevel',
				WhiteTuningLevelParameters: {
					Level: input.level ?? currentStatus?.level ?? 100,
					WhiteTuningLevel: {
						Kelvin: input.kelvin,
					},
				},
			},
		})
		assertSuccessfulResponse(response, `zone ${zoneId} white tuning set`)
		return response
	} finally {
		await client.close()
	}
}

export async function setLutronZoneSwitchedLevel(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	zoneId: string
	state: 'On' | 'Off'
}) {
	const zoneId = normalizeLutronZoneId(input.zoneId)
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const response = await client.create(`/zone/${zoneId}/commandprocessor`, {
			Command: {
				CommandType: 'GoToSwitchedLevel',
				SwitchedLevelParameters: {
					SwitchedLevel: input.state,
				},
			},
		})
		assertSuccessfulResponse(response, `zone ${zoneId} switched level set`)
		return response
	} finally {
		await client.close()
	}
}

export async function setLutronShadeLevel(input: {
	processor: LutronPersistedProcessor
	credentials: LutronCredentials
	zoneId: string
	level: number
}) {
	const zoneId = normalizeLutronZoneId(input.zoneId)
	const client = await createLutronLeapClient(input.processor)
	try {
		await client.login(input.credentials)
		const response = await client.create(`/zone/${zoneId}/commandprocessor`, {
			Command: {
				CommandType: 'GoToShadeLevel',
				ShadeLevelParameters: {
					Level: input.level,
				},
			},
		})
		assertSuccessfulResponse(response, `zone ${zoneId} shade level set`)
		return response
	} finally {
		await client.close()
	}
}
