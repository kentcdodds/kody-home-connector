import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import {
	clearPhoneDeviceToken,
	getPhoneDeviceToken,
	hasStoredPhoneDeviceToken,
	savePhoneDeviceToken,
} from './repository.ts'

function createStorage(overrides: { sharedSecret?: string | null } = {}) {
	const directory = mkdtempSync(
		path.join(tmpdir(), 'kody-home-connector-phone-'),
	)
	const storage = createHomeConnectorStorage(
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
		close() {
			storage.close()
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

test('sqlite storage persists an encrypted phone device token', () => {
	const { storage, close } = createStorage()
	try {
		expect(hasStoredPhoneDeviceToken(storage, 'default')).toBe(false)
		savePhoneDeviceToken({
			storage,
			connectorId: 'default',
			token: '  phone-token  ',
		})
		expect(hasStoredPhoneDeviceToken(storage, 'default')).toBe(true)
		expect(getPhoneDeviceToken(storage, 'default')).toBe('phone-token')

		const row = storage.db
			.query(
				`
					SELECT token
					FROM phone_device_tokens
					WHERE connector_id = ?
				`,
			)
			.get('default') as { token: string }
		expect(row.token).toContain('enc:v1:')
		expect(row.token).not.toContain('phone-token')

		clearPhoneDeviceToken(storage, 'default')
		expect(hasStoredPhoneDeviceToken(storage, 'default')).toBe(false)
		expect(getPhoneDeviceToken(storage, 'default')).toBeNull()
	} finally {
		close()
	}
})

test('saving a phone device token requires HOME_CONNECTOR_DATA_KEY', () => {
	const { storage, close } = createStorage({ sharedSecret: null })
	try {
		expect(() =>
			savePhoneDeviceToken({
				storage,
				connectorId: 'default',
				token: 'phone-token',
			}),
		).toThrow(/HOME_CONNECTOR_DATA_KEY/)
	} finally {
		close()
	}
})
