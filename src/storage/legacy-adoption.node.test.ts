import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { listSamsungTvDevices } from '../adapters/samsung-tv/repository.ts'
import { listVenstarThermostats } from '../adapters/venstar/repository.ts'
import { readActiveOAuthToken } from '../oauth/store.ts'
import { createTestHomeConnectorConfig } from '../test-home-connector-config.ts'
import {
	createHomeConnectorStorage,
	loadHomeConnectorMigrations,
} from './index.ts'
import { homeConnectorLogs } from './schema.ts'

const legacySchemaSql = readFileSync(
	path.join(import.meta.dirname, 'fixtures/legacy-schema.sql'),
	'utf8',
)

function listSchemaObjects(dbPath: string) {
	const sqlite = new DatabaseSync(dbPath, { readOnly: true })
	try {
		return sqlite
			.prepare(
				`SELECT type, name FROM sqlite_master
				 WHERE name NOT LIKE 'sqlite_%'
				 ORDER BY type, name`,
			)
			.all() as Array<{ type: string; name: string }>
	} finally {
		sqlite.close()
	}
}

function createLegacyDatabase(dbPath: string) {
	const sqlite = new DatabaseSync(dbPath)
	try {
		sqlite.exec('PRAGMA foreign_keys = ON;')
		sqlite.exec(legacySchemaSql)
		sqlite
			.prepare(
				`INSERT INTO venstar_thermostats (connector_id, ip, name, last_seen_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				'default',
				'192.168.10.40',
				'Hallway',
				'2026-04-13T18:00:00.000Z',
				'2026-04-13T18:00:00.000Z',
			)
		sqlite
			.prepare(
				`INSERT INTO samsung_tvs (
					connector_id, device_id, host, name, service_url, model, model_name,
					mac_address, frame_tv_support, token_auth_support, power_state,
					raw_device_info_json, adopted, last_seen_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				'default',
				'samsung-tv-one',
				'frame-tv.local',
				'Living Room The Frame',
				'http://frame-tv.local:8001/api/v2/',
				'24_PONTUSM_FTV',
				'QN65LS03DAFXZA',
				'F4:DD:06:67:B6:16',
				1,
				1,
				'on',
				'{"name":"Living Room The Frame"}',
				1,
				'2026-03-25T17:00:00.000Z',
				'2026-03-25T17:00:00.000Z',
			)
		sqlite
			.prepare(
				`INSERT INTO samsung_tokens (
					connector_id, device_id, token, last_verified_at, last_auth_error, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				'default',
				'samsung-tv-one',
				'legacy-token',
				'2026-03-25T17:05:00.000Z',
				null,
				'2026-03-25T17:05:00.000Z',
			)
		sqlite
			.prepare(
				`INSERT INTO oauth_tokens (
					token_hash, token_kind, client_id, resource, scope, expires_at, revoked_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				'legacy-token-hash',
				'access',
				'kody',
				'http://localhost:4040/mcp',
				'mcp',
				4_000_000_000,
				null,
			)
		sqlite
			.prepare(
				`INSERT INTO home_connector_logs (
					connector_id, level, event, message, metadata_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				'default',
				'info',
				'legacy.event',
				'written by the previous release',
				'{}',
				new Date().toISOString(),
			)
	} finally {
		sqlite.close()
	}
}

test('baseline migration adopts a database created by the previous release', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	createLegacyDatabase(dbPath)
	const legacyObjects = listSchemaObjects(dbPath)
	expect(
		legacyObjects.filter((object) => object.type === 'table'),
	).toHaveLength(20)

	const config = createTestHomeConnectorConfig({
		dataPath: directory,
		dbPath,
	})

	try {
		const storage = await createHomeConnectorStorage(config)
		try {
			const status = await storage.db.migrationStatus(
				await loadHomeConnectorMigrations(),
			)
			expect(status.map((entry) => [entry.name, entry.status])).toEqual([
				['baseline_schema', 'applied'],
			])

			expect(await listVenstarThermostats(storage, 'default')).toEqual([
				{
					name: 'Hallway',
					ip: '192.168.10.40',
					lastSeenAt: '2026-04-13T18:00:00.000Z',
				},
			])
			const devices = await listSamsungTvDevices(storage, 'default')
			expect(devices).toHaveLength(1)
			expect(devices[0]).toMatchObject({
				deviceId: 'samsung-tv-one',
				adopted: true,
				token: 'legacy-token',
				lastVerifiedAt: '2026-03-25T17:05:00.000Z',
			})
			expect(
				await readActiveOAuthToken(
					storage.db,
					'legacy-token-hash',
					Math.floor(Date.now() / 1000),
				),
			).toMatchObject({ tokenKind: 'access', clientId: 'kody' })
			const logs = await storage.db.findMany(homeConnectorLogs, {
				where: { connector_id: 'default' },
			})
			expect(logs.map((log) => log.event)).toEqual(['legacy.event'])
		} finally {
			await storage.close()
		}

		expect(listSchemaObjects(dbPath)).toEqual(
			[...legacyObjects, { type: 'table', name: 'data_table_migrations' }].sort(
				(a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
			),
		)

		const reopened = await createHomeConnectorStorage(config)
		try {
			const status = await reopened.db.migrationStatus(
				await loadHomeConnectorMigrations(),
			)
			expect(status.map((entry) => entry.status)).toEqual(['applied'])
			expect(await listVenstarThermostats(reopened, 'default')).toHaveLength(1)
		} finally {
			await reopened.close()
		}
	} finally {
		rmSync(directory, { force: true, recursive: true })
	}
})

test('an empty database receives the full schema and a journaled baseline', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'nested', 'home-connector.sqlite')
	const config = createTestHomeConnectorConfig({
		dataPath: directory,
		dbPath,
	})

	try {
		const storage = await createHomeConnectorStorage(config)
		try {
			expect(await listVenstarThermostats(storage, 'default')).toEqual([])
		} finally {
			await storage.close()
		}

		const legacyDirectory = mkdtempSync(
			path.join(tmpdir(), 'kody-home-connector-legacy-'),
		)
		const legacyDbPath = path.join(legacyDirectory, 'home-connector.sqlite')
		try {
			createLegacyDatabase(legacyDbPath)
			expect(
				listSchemaObjects(dbPath).filter(
					(object) => object.name !== 'data_table_migrations',
				),
			).toEqual(listSchemaObjects(legacyDbPath))
		} finally {
			rmSync(legacyDirectory, { force: true, recursive: true })
		}
	} finally {
		rmSync(directory, { force: true, recursive: true })
	}
})
