import { type HomeConnectorStorage } from '../storage/index.ts'
import { connectorRuntimeSettings } from '../storage/schema.ts'
import { encryptSecret, decryptSecret } from '../storage/encrypted-secret.ts'
import {
	getRuntimeSettingDefinition,
	type RuntimeSettingDefinition,
} from './definitions.ts'

export type StoredRuntimeSettingRow = {
	key: string
	value: unknown
	updatedAt: string
}

function serializeValue(value: unknown) {
	return JSON.stringify(value)
}

function deserializeValue(valueJson: string): unknown {
	return JSON.parse(valueJson) as unknown
}

function encodeStoredValue(
	definition: RuntimeSettingDefinition,
	value: unknown,
	sharedSecret: string | null,
) {
	if (!definition.secret) {
		return serializeValue(value)
	}
	if (typeof value !== 'string') {
		throw new Error(`${definition.field} secret values must be strings.`)
	}
	return serializeValue(
		encryptSecret({
			value,
			sharedSecret,
			missingSecretMessage: `Cannot store ${definition.key} without HOME_CONNECTOR_SHARED_SECRET.`,
		}),
	)
}

function decodeStoredValue(
	definition: RuntimeSettingDefinition,
	valueJson: string,
	sharedSecret: string | null,
): unknown {
	const parsed = deserializeValue(valueJson)
	if (!definition.secret) return parsed
	if (typeof parsed !== 'string') return null
	return decryptSecret(parsed, sharedSecret)
}

export async function listStoredRuntimeSettings(
	storage: HomeConnectorStorage,
	connectorId: string,
): Promise<Array<StoredRuntimeSettingRow>> {
	const rows = await storage.db.findMany(connectorRuntimeSettings, {
		where: { connector_id: connectorId },
	})
	const results: Array<StoredRuntimeSettingRow> = []
	for (const row of rows) {
		const definition = getRuntimeSettingDefinition(row.setting_key)
		if (!definition) continue
		const value = decodeStoredValue(
			definition,
			row.value_json,
			storage.sharedSecret,
		)
		results.push({
			key: row.setting_key,
			value,
			updatedAt: row.updated_at,
		})
	}
	return results
}

export async function getStoredRuntimeSetting(
	storage: HomeConnectorStorage,
	connectorId: string,
	key: string,
): Promise<StoredRuntimeSettingRow | null> {
	const definition = getRuntimeSettingDefinition(key)
	if (!definition) return null
	const row = await storage.db.find(connectorRuntimeSettings, {
		connector_id: connectorId,
		setting_key: key,
	})
	if (!row) return null
	return {
		key: row.setting_key,
		value: decodeStoredValue(definition, row.value_json, storage.sharedSecret),
		updatedAt: row.updated_at,
	}
}

export async function upsertStoredRuntimeSetting(input: {
	storage: HomeConnectorStorage
	connectorId: string
	definition: RuntimeSettingDefinition
	value: unknown
}) {
	await input.storage.db.query(connectorRuntimeSettings).upsert({
		connector_id: input.connectorId,
		setting_key: input.definition.key,
		value_json: encodeStoredValue(
			input.definition,
			input.value,
			input.storage.sharedSecret,
		),
	})
}

export async function deleteStoredRuntimeSetting(input: {
	storage: HomeConnectorStorage
	connectorId: string
	key: string
}) {
	await input.storage.db.delete(connectorRuntimeSettings, {
		connector_id: input.connectorId,
		setting_key: input.key,
	})
}

export async function deleteStoredRuntimeSettingsForIntegration(input: {
	storage: HomeConnectorStorage
	connectorId: string
	keys: Array<string>
}) {
	for (const key of input.keys) {
		await deleteStoredRuntimeSetting({
			storage: input.storage,
			connectorId: input.connectorId,
			key,
		})
	}
}
