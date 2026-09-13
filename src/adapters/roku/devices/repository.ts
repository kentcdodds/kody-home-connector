import { and, notInList, type TableRow } from 'remix/data-table'
import {
	getAdoptedRokuDevices as getAdoptedDevicesFromState,
	getDiscoveredRokuDevices as getDiscoveredDevicesFromState,
	setRokuDevices,
	type HomeConnectorState,
} from '../../../state.ts'
import { type HomeConnectorStorage } from '../../../storage/index.ts'
import { rokuDevices } from '../../../storage/schema.ts'
import { compareNoCase, compareText } from '../../../storage/sort.ts'
import { type RokuDeviceRecord } from '../types.ts'

function mapRokuDeviceRow(row: TableRow<typeof rokuDevices>): RokuDeviceRecord {
	const adopted = Boolean(row.adopted)
	return {
		deviceId: row.device_id,
		id: row.roku_id,
		name: row.name,
		location: row.location,
		serialNumber: row.serial_number,
		modelName: row.model_name,
		isAdopted: adopted,
		lastSeenAt: row.last_seen_at,
		controlEnabled: Boolean(row.control_enabled),
		adopted,
	}
}

export function syncRokuAdoptionFlags(
	devices: Array<RokuDeviceRecord>,
): Array<RokuDeviceRecord> {
	return devices.map((device) => ({
		...device,
		isAdopted: device.adopted,
	}))
}

export function mergePersistedAdoptedRokuDevices(input: {
	scanned: Array<RokuDeviceRecord>
	persisted: Array<RokuDeviceRecord>
}) {
	const scannedIds = new Set(input.scanned.map((device) => device.deviceId))
	const adoptedMissing = input.persisted.filter(
		(device) => device.adopted && !scannedIds.has(device.deviceId),
	)
	return syncRokuAdoptionFlags([...input.scanned, ...adoptedMissing])
}

export async function listRokuDevices(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const rows = await storage.db.findMany(rokuDevices, {
		where: { connector_id: connectorId },
	})
	return rows
		.sort(
			(a, b) =>
				compareNoCase(a.name, b.name) || compareText(a.device_id, b.device_id),
		)
		.map(mapRokuDeviceRow)
}

export async function getRokuDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	const row = await storage.db.find(rokuDevices, {
		connector_id: connectorId,
		device_id: deviceId,
	})
	return row ? mapRokuDeviceRow(row) : null
}

export async function upsertDiscoveredRokuDevices(
	storage: HomeConnectorStorage,
	connectorId: string,
	devices: Array<RokuDeviceRecord>,
) {
	const known = await listRokuDevices(storage, connectorId)
	const knownById = new Map(known.map((device) => [device.deviceId, device]))
	for (const device of devices) {
		const existing = knownById.get(device.deviceId)
		const values = {
			roku_id: device.id,
			name: device.name,
			location: device.location,
			serial_number: device.serialNumber,
			model_name: device.modelName,
			control_enabled: device.controlEnabled ? 1 : 0,
			last_seen_at: device.lastSeenAt,
		}
		const key = { connector_id: connectorId, device_id: device.deviceId }
		if (existing) {
			await storage.db.update(rokuDevices, key, values)
		} else {
			await storage.db.create(rokuDevices, {
				...key,
				adopted: 0,
				...values,
			})
			knownById.set(device.deviceId, {
				...device,
				adopted: false,
				isAdopted: false,
			})
		}
	}
	// Empty scans (failed SSDP) must not prune persisted unadopted devices.
	if (devices.length > 0) {
		await storage.db.deleteMany(rokuDevices, {
			where: and(
				{ connector_id: connectorId, adopted: 0 },
				notInList(
					'device_id',
					devices.map((device) => device.deviceId),
				),
			),
		})
	}
	return listRokuDevices(storage, connectorId)
}

export async function persistRokuAdoption(
	storage: HomeConnectorStorage,
	connectorId: string,
	device: RokuDeviceRecord,
) {
	const existing = await getRokuDevice(storage, connectorId, device.deviceId)
	const values = {
		roku_id: device.id,
		name: device.name,
		location: device.location,
		serial_number: device.serialNumber,
		model_name: device.modelName,
		adopted: device.adopted ? 1 : 0,
		control_enabled: device.controlEnabled ? 1 : 0,
		last_seen_at: device.lastSeenAt,
	}
	const key = { connector_id: connectorId, device_id: device.deviceId }
	if (existing) {
		await storage.db.update(rokuDevices, key, values)
	} else {
		await storage.db.create(rokuDevices, {
			...key,
			...values,
		})
	}
	return getRokuDevice(storage, connectorId, device.deviceId)
}

export async function deleteRokuDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	await storage.db.deleteMany(rokuDevices, {
		where: { connector_id: connectorId, device_id: deviceId },
	})
}

export function getDiscoveredRokuDevices(state: HomeConnectorState) {
	return getDiscoveredDevicesFromState(state)
}

export function getAdoptedRokuDevices(state: HomeConnectorState) {
	return getAdoptedDevicesFromState(state)
}

export function updateDiscoveredRokuDevices(
	state: HomeConnectorState,
	devices: Array<RokuDeviceRecord>,
) {
	const adoptedById = new Map(
		getAdoptedDevicesFromState(state).map((device) => [
			device.deviceId,
			device,
		]),
	)
	const nextDevices = syncRokuAdoptionFlags(
		devices.map((device) => {
			const adopted = adoptedById.get(device.deviceId)
			return {
				...device,
				adopted: Boolean(adopted),
				controlEnabled: adopted?.controlEnabled ?? device.controlEnabled,
			}
		}),
	)
	const scannedIds = new Set(nextDevices.map((device) => device.deviceId))
	const adoptedMissing = [...adoptedById.values()].filter(
		(device) => !scannedIds.has(device.deviceId),
	)
	setRokuDevices(
		state,
		syncRokuAdoptionFlags([...nextDevices, ...adoptedMissing]),
	)
}

export function adoptRokuDevice(state: HomeConnectorState, deviceId: string) {
	const nextDevices = syncRokuAdoptionFlags(
		state.devices.map((device) =>
			device.deviceId === deviceId
				? { ...device, adopted: true, isAdopted: true }
				: device,
		),
	)
	const adoptedDevice =
		nextDevices.find((device) => device.deviceId === deviceId) ?? null
	if (!adoptedDevice) return null
	setRokuDevices(state, nextDevices)
	return adoptedDevice
}

export function ignoreRokuDevice(state: HomeConnectorState, deviceId: string) {
	setRokuDevices(
		state,
		state.devices.filter((device) => device.deviceId !== deviceId),
	)
}
