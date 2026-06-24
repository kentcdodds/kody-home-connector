import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { getKasaPlug } from './repository.ts'

function createConfig() {
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

test('Kasa repository tolerates malformed persisted sysinfo JSON', () => {
	const config = createConfig()
	const storage = createHomeConnectorStorage(config)
	try {
		storage.db
			.query(
				`
				INSERT INTO kasa_plugs (
					connector_id,
					plug_id,
					alias,
					host,
					port,
					raw_sysinfo_json,
					last_seen_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
			)
			.run(
				config.homeConnectorId,
				'kasa-plug-bad-json',
				'Bad JSON Plug',
				'192.168.10.70',
				9999,
				'{not-json',
				'2026-06-24T14:00:00.000Z',
				'2026-06-24T14:00:00.000Z',
			)

		expect(
			getKasaPlug(storage, config.homeConnectorId, 'kasa-plug-bad-json'),
		).toMatchObject({
			plugId: 'kasa-plug-bad-json',
			rawSysInfo: {},
		})
	} finally {
		storage.close()
	}
})
