import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
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
	overrides: Partial<ReturnType<typeof createConfigBase>> = {},
) {
	return {
		...createConfigBase(dbPath),
		...overrides,
	}
}

function createConfigBase(dbPath: string) {
	return {
		homeConnectorId: 'default',
		publicBaseUrl: 'http://localhost:4040',
		mcpPath: '/mcp',
		mcpUrl: 'http://localhost:4040/mcp',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
		islandRouterHost: null,
		islandRouterPort: 22,
		islandRouterUsername: null,
		islandRouterPrivateKeyPath: null,
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8_000,
		islandRouterApiBaseUrl: 'https://my.islandrouter.com',
		islandRouterApiRequestTimeoutMs: 8_000,
		islandRouterApiAllowInsecureTls: false,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		courtPjlinkProjectorId: null,
		pjlinkScanCidrs: ['192.168.0.128/32'],
		pjlinkScanExtraHosts: ['192.168.0.128'],
		pjlinkRequestTimeoutMs: 5_000,
		courtPjlinkTimeoutMs: 1_500,
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
	}
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
