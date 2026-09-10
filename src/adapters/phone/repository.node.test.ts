import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { phoneDeviceTokens } from '../../storage/schema.ts'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import {
	clearPhoneDeviceToken,
	getPhoneDeviceToken,
	hasStoredPhoneDeviceToken,
	savePhoneDeviceToken,
} from './repository.ts'

async function createStorage(overrides: { sharedSecret?: string | null } = {}) {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-phone-'),
	)
	const storage = await createHomeConnectorStorage(
		createTestHomeConnectorConfig({
			dataPath: directory,
			dbPath: path.join(directory, 'home-connector.sqlite'),
			sharedSecret:
				overrides.sharedSecret === undefined
					? 'secret'
					: overrides.sharedSecret,
		}),
	)
	return {
		storage,
		async close() {
			await storage.close()
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

test('sqlite storage persists an encrypted phone device token', async () => {
	const { storage, close } = await createStorage()
	try {
		expect(await hasStoredPhoneDeviceToken(storage, 'default')).toBe(false)
		await savePhoneDeviceToken({
			storage,
			connectorId: 'default',
			token: '  phone-token  ',
		})
		expect(await hasStoredPhoneDeviceToken(storage, 'default')).toBe(true)
		expect(await getPhoneDeviceToken(storage, 'default')).toBe('phone-token')

		const row = await storage.db.find(phoneDeviceTokens, {
			connector_id: 'default',
		})
		expect(row?.token).toContain('enc:v1:')
		expect(row?.token).not.toContain('phone-token')

		await clearPhoneDeviceToken(storage, 'default')
		expect(await hasStoredPhoneDeviceToken(storage, 'default')).toBe(false)
		expect(await getPhoneDeviceToken(storage, 'default')).toBeNull()
	} finally {
		await close()
	}
})

test('saving a phone device token requires HOME_CONNECTOR_DATA_KEY', async () => {
	const { storage, close } = await createStorage({ sharedSecret: null })
	try {
		await expect(
			savePhoneDeviceToken({
				storage,
				connectorId: 'default',
				token: 'phone-token',
			}),
		).rejects.toThrow(/HOME_CONNECTOR_DATA_KEY/)
	} finally {
		await close()
	}
})
