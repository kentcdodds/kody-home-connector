import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import { accessNetworksUnleashedCredentials } from '../../storage/schema.ts'
import {
	getAdoptedAccessNetworksUnleashedController,
	listAccessNetworksUnleashedControllers,
	listAccessNetworksUnleashedPublicControllers,
	removeAccessNetworksUnleashedController,
	saveAccessNetworksUnleashedCredentials,
	upsertDiscoveredAccessNetworksUnleashedControllers,
	adoptAccessNetworksUnleashedController,
} from './repository.ts'

function createConfig(
	dbPath: string,
	overrides: Partial<HomeConnectorConfig> = {},
) {
	return createTestHomeConnectorConfig({
		dataPath: path.dirname(dbPath),
		dbPath,
		mocksEnabled: true,
		...overrides,
	})
}

test('sqlite storage persists Unleashed controllers and encrypted credentials', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))

	try {
		await upsertDiscoveredAccessNetworksUnleashedControllers(
			storage,
			'default',
			[
				{
					controllerId: '192.168.1.10',
					name: 'Unleashed Kitchen',
					host: '192.168.1.10',
					loginUrl: 'https://192.168.1.10/admin/wsg/login.jsp',
					lastSeenAt: '2026-05-03T19:20:00.000Z',
					rawDiscovery: { probeUrl: 'https://192.168.1.10/' },
				},
				{
					controllerId: '192.168.1.11',
					name: 'Unleashed Office',
					host: '192.168.1.11',
					loginUrl: 'https://192.168.1.11/admin/wsg/login.jsp',
					lastSeenAt: '2026-05-03T19:21:00.000Z',
					rawDiscovery: { probeUrl: 'https://192.168.1.11/' },
				},
			],
		)
		await adoptAccessNetworksUnleashedController(
			storage,
			'default',
			'192.168.1.11',
		)
		await saveAccessNetworksUnleashedCredentials({
			storage,
			connectorId: 'default',
			controllerId: '192.168.1.11',
			username: 'admin-user',
			password: 'admin-pass',
			lastAuthenticatedAt: '2026-05-03T19:22:00.000Z',
		})

		const controllers = await listAccessNetworksUnleashedControllers(
			storage,
			'default',
		)
		expect(controllers).toHaveLength(2)
		expect(
			await getAdoptedAccessNetworksUnleashedController(storage, 'default'),
		).toMatchObject({
			controllerId: '192.168.1.11',
			adopted: true,
			username: 'admin-user',
			password: 'admin-pass',
			lastAuthenticatedAt: '2026-05-03T19:22:00.000Z',
		})

		const publicControllers =
			await listAccessNetworksUnleashedPublicControllers(storage, 'default')
		expect(publicControllers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					controllerId: '192.168.1.10',
					adopted: false,
					hasStoredCredentials: false,
				}),
				expect.objectContaining({
					controllerId: '192.168.1.11',
					adopted: true,
					hasStoredCredentials: true,
					lastAuthenticatedAt: '2026-05-03T19:22:00.000Z',
				}),
			]),
		)

		const rawPasswordRow = await storage.db.find(
			accessNetworksUnleashedCredentials,
			{ connector_id: 'default', controller_id: '192.168.1.11' },
		)
		expect(rawPasswordRow?.password).toMatch(/^enc:v1:/)
		expect(rawPasswordRow?.password).not.toContain('admin-pass')
		expect(rawPasswordRow?.password?.split(':')).toHaveLength(5)

		await removeAccessNetworksUnleashedController({
			storage,
			connectorId: 'default',
			controllerId: '192.168.1.11',
		})
		expect(
			await storage.db.find(accessNetworksUnleashedCredentials, {
				connector_id: 'default',
				controller_id: '192.168.1.11',
			}),
		).toBeNull()

		const mismatchedSecretStorage = await createHomeConnectorStorage(
			createConfig(path.join(directory, 'wrong-secret.sqlite'), {
				sharedSecret: 'wrong-secret',
			}),
		)
		try {
			await upsertDiscoveredAccessNetworksUnleashedControllers(
				mismatchedSecretStorage,
				'default',
				[
					{
						controllerId: '192.168.1.11',
						name: 'Unleashed Office',
						host: '192.168.1.11',
						loginUrl: 'https://192.168.1.11/admin/wsg/login.jsp',
						lastSeenAt: '2026-05-03T19:21:00.000Z',
						rawDiscovery: { probeUrl: 'https://192.168.1.11/' },
					},
				],
			)
			const copiedCiphertext = rawPasswordRow?.password
			if (!copiedCiphertext) {
				throw new Error('Expected encrypted password row to exist')
			}
			await mismatchedSecretStorage.db.create(
				accessNetworksUnleashedCredentials,
				{
					connector_id: 'default',
					controller_id: '192.168.1.11',
					username: 'admin-user',
					password: copiedCiphertext,
					last_authenticated_at: '2026-05-03T19:22:00.000Z',
					last_auth_error: null,
					updated_at: '2026-05-03T19:22:00.000Z',
				},
			)

			expect(
				await listAccessNetworksUnleashedPublicControllers(
					mismatchedSecretStorage,
					'default',
				),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						controllerId: '192.168.1.11',
						hasStoredCredentials: false,
					}),
				]),
			)
		} finally {
			await mismatchedSecretStorage.close()
		}
	} finally {
		await storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('adopting a lexicographically earlier controller still succeeds with the unique adopted index', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = await createHomeConnectorStorage(createConfig(dbPath))

	try {
		await upsertDiscoveredAccessNetworksUnleashedControllers(
			storage,
			'default',
			[
				{
					controllerId: '192.168.1.2',
					name: 'Later Controller',
					host: '192.168.1.2',
					loginUrl: 'https://192.168.1.2/admin/wsg/login.jsp',
					lastSeenAt: '2026-05-03T19:30:00.000Z',
					rawDiscovery: null,
				},
				{
					controllerId: '192.168.1.10',
					name: 'Earlier Controller',
					host: '192.168.1.10',
					loginUrl: 'https://192.168.1.10/admin/wsg/login.jsp',
					lastSeenAt: '2026-05-03T19:31:00.000Z',
					rawDiscovery: null,
				},
			],
		)

		await adoptAccessNetworksUnleashedController(
			storage,
			'default',
			'192.168.1.2',
		)
		await adoptAccessNetworksUnleashedController(
			storage,
			'default',
			'192.168.1.10',
		)

		expect(
			await getAdoptedAccessNetworksUnleashedController(storage, 'default'),
		).toMatchObject({
			controllerId: '192.168.1.10',
			adopted: true,
		})

		expect(
			(await listAccessNetworksUnleashedControllers(storage, 'default')).filter(
				(controller) => controller.adopted,
			),
		).toHaveLength(1)
	} finally {
		await storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})
