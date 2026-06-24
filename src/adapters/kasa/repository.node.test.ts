import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { getKasaPlug } from './repository.ts'

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

test('Kasa repository tolerates malformed persisted sysinfo JSON', () => {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
		HOME_CONNECTOR_DB_PATH: ':memory:',
	})
	const config = loadHomeConnectorConfig()
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
