import { and, notInList, type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { samsungTokens, samsungTvs } from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import {
	type SamsungTvDeviceRecord,
	type SamsungTvPersistedDevice,
} from './types.ts'

function mapSamsungTvRow(
	row: TableRow<typeof samsungTvs>,
	token: TableRow<typeof samsungTokens> | undefined,
): SamsungTvPersistedDevice {
	return {
		deviceId: row.device_id,
		name: row.name,
		host: row.host,
		serviceUrl: row.service_url,
		model: row.model,
		modelName: row.model_name,
		macAddress: row.mac_address,
		frameTvSupport: Boolean(row.frame_tv_support),
		tokenAuthSupport: Boolean(row.token_auth_support),
		powerState: row.power_state,
		lastSeenAt: row.last_seen_at,
		adopted: Boolean(row.adopted),
		rawDeviceInfo: row.raw_device_info_json
			? (JSON.parse(row.raw_device_info_json) as Record<string, unknown>)
			: null,
		token: token?.token ?? null,
		lastVerifiedAt: token?.last_verified_at ?? null,
		lastAuthError: token?.last_auth_error ?? null,
	}
}

export async function listSamsungTvDevices(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const [tvs, tokens] = await Promise.all([
		storage.db.findMany(samsungTvs, { where: { connector_id: connectorId } }),
		storage.db.findMany(samsungTokens, {
			where: { connector_id: connectorId },
		}),
	])
	const tokensByDevice = new Map(
		tokens.map((token) => [token.device_id, token]),
	)
	return tvs
		.sort(
			(a, b) =>
				compareNoCase(a.name, b.name) || compareText(a.device_id, b.device_id),
		)
		.map((row) => mapSamsungTvRow(row, tokensByDevice.get(row.device_id)))
}

export async function getSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	const key = { connector_id: connectorId, device_id: deviceId }
	const [row, token] = await Promise.all([
		storage.db.find(samsungTvs, key),
		storage.db.find(samsungTokens, key),
	])
	return row ? mapSamsungTvRow(row, token ?? undefined) : null
}

export async function upsertDiscoveredSamsungTvs(
	storage: HomeConnectorStorage,
	connectorId: string,
	devices: Array<SamsungTvDeviceRecord>,
) {
	const existing = new Map(
		(await listSamsungTvDevices(storage, connectorId)).map((device) => [
			device.deviceId,
			device,
		]),
	)
	for (const device of devices) {
		const current = existing.get(device.deviceId)
		const values = {
			host: device.host,
			name: device.name,
			service_url: device.serviceUrl,
			model: device.model,
			model_name: device.modelName,
			mac_address: device.macAddress,
			frame_tv_support: device.frameTvSupport ? 1 : 0,
			token_auth_support: device.tokenAuthSupport ? 1 : 0,
			power_state: device.powerState,
			raw_device_info_json: device.rawDeviceInfo
				? JSON.stringify(device.rawDeviceInfo)
				: null,
			last_seen_at: device.lastSeenAt,
		}
		await storage.db.query(samsungTvs).upsert(
			{
				connector_id: connectorId,
				device_id: device.deviceId,
				adopted: current?.adopted ? 1 : device.adopted ? 1 : 0,
				...values,
			},
			{ update: values },
		)
	}
	await storage.db.deleteMany(samsungTvs, {
		where: and(
			{ connector_id: connectorId, adopted: 0 },
			notInList(
				'device_id',
				devices.map((device) => device.deviceId),
			),
		),
	})
	return listSamsungTvDevices(storage, connectorId)
}

async function setSamsungTvAdopted(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
	adopted: boolean,
) {
	await storage.db.updateMany(
		samsungTvs,
		{ adopted: adopted ? 1 : 0 },
		{ where: { connector_id: connectorId, device_id: deviceId } },
	)
	return getSamsungTvDevice(storage, connectorId, deviceId)
}

export function adoptSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	return setSamsungTvAdopted(storage, connectorId, deviceId, true)
}

export function ignoreSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	return setSamsungTvAdopted(storage, connectorId, deviceId, false)
}

export async function saveSamsungTvToken(input: {
	storage: HomeConnectorStorage
	connectorId: string
	deviceId: string
	token: string
	lastVerifiedAt?: string | null
	lastAuthError?: string | null
}) {
	await input.storage.db.query(samsungTokens).upsert({
		connector_id: input.connectorId,
		device_id: input.deviceId,
		token: input.token,
		last_verified_at: input.lastVerifiedAt ?? new Date().toISOString(),
		last_auth_error: input.lastAuthError ?? null,
	})
}

export async function updateSamsungTvPowerState(input: {
	storage: HomeConnectorStorage
	connectorId: string
	deviceId: string
	powerState: string | null
}) {
	await input.storage.db.updateMany(
		samsungTvs,
		{ power_state: input.powerState },
		{ where: { connector_id: input.connectorId, device_id: input.deviceId } },
	)
}

export async function updateSamsungTvTokenError(input: {
	storage: HomeConnectorStorage
	connectorId: string
	deviceId: string
	lastAuthError: string | null
	lastVerifiedAt?: string | null
}) {
	await input.storage.db.updateMany(
		samsungTokens,
		{
			last_auth_error: input.lastAuthError,
			last_verified_at: input.lastVerifiedAt ?? null,
		},
		{ where: { connector_id: input.connectorId, device_id: input.deviceId } },
	)
}

export async function requireSamsungTvDevice(
	storage: HomeConnectorStorage,
	connectorId: string,
	deviceId: string,
) {
	const device = await getSamsungTvDevice(storage, connectorId, deviceId)
	if (!device) {
		throw new Error(`Samsung TV device "${deviceId}" was not found.`)
	}
	return device
}
