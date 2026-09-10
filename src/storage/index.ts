import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadMigrations } from 'remix/data-table/migrations/node'
import {
	createSqliteDatabase,
	type SqliteDatabase,
} from 'remix/data-table/sqlite'
import { type HomeConnectorConfig } from '../config.ts'

export type HomeConnectorDatabase = SqliteDatabase

export type HomeConnectorStorage = {
	db: HomeConnectorDatabase
	sharedSecret: string | null
	close(): Promise<void>
}

export const migrationsDirectory = path.resolve(
	import.meta.dirname,
	'../../db/migrations',
)

function ensureParentDirectory(dbPath: string) {
	if (dbPath === ':memory:') return
	mkdirSync(path.dirname(dbPath), {
		recursive: true,
	})
}

export function createHomeConnectorDatabase(dbPath: string) {
	ensureParentDirectory(dbPath)
	return createSqliteDatabase(
		{ filename: dbPath, foreignKeys: true },
		{ now: () => new Date().toISOString() },
	)
}

export async function migrateHomeConnectorDatabase(db: HomeConnectorDatabase) {
	await db.migrate(await loadMigrations(migrationsDirectory))
}

export async function createHomeConnectorStorage(
	config: HomeConnectorConfig,
): Promise<HomeConnectorStorage> {
	const db = createHomeConnectorDatabase(config.dbPath)
	await migrateHomeConnectorDatabase(db)
	return {
		db,
		sharedSecret: config.sharedSecret,
		async close() {
			await db.close()
		},
	}
}
