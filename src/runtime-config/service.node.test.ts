import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../config.ts'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { createRuntimeConfigService } from './service.ts'

const requiredConfigEnv = {
	HOME_CONNECTOR_ID: 'default',
	HOME_CONNECTOR_SHARED_SECRET: 'home-connector-secret-home-connector-secret',
	HOME_CONNECTOR_DB_PATH: ':memory:',
	VENSTAR_SCAN_CIDRS: '192.168.10.40/32',
}

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previous = new Map<string, string | undefined>()
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key])
		if (value === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}
	return {
		[Symbol.dispose]() {
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		},
	}
}

async function createService(env: Record<string, string | undefined> = {}) {
	const disposeEnv = createTemporaryEnv({
		...requiredConfigEnv,
		...env,
	})
	const config = loadHomeConnectorConfig()
	const storage = await createHomeConnectorStorage(config)
	const runtimeConfig = createRuntimeConfigService({ config, storage })
	await runtimeConfig.applyStoredOverrides()
	return { config, storage, runtimeConfig, disposeEnv }
}

test('stored Araknis settings override env and apply without reload', async () => {
	const { config, runtimeConfig, storage, disposeEnv } = await createService({
		ARAKNIS_SWITCH_BASE_URL: 'https://192.168.0.50',
		ARAKNIS_SWITCH_ALLOW_INSECURE_TLS: 'true',
		ARAKNIS_SWITCH_SSH_ENABLED: 'false',
	})
	using _env = disposeEnv

	expect(config.araknisSwitchBaseUrl).toBe('https://192.168.0.50')
	expect(config.araknisSwitchAllowInsecureTls).toBe(true)
	expect(config.araknisSwitchSshEnabled).toBe(false)

	const before = await runtimeConfig.getIntegrationConfig('araknis_switch')
	expect(
		before.settings.find((setting) => setting.field === 'baseUrl')?.source,
	).toBe('env')
	expect(
		before.settings.find((setting) => setting.field === 'allowInsecureTls')
			?.source,
	).toBe('env')

	await runtimeConfig.setIntegrationConfig('araknis_switch', {
		baseUrl: 'https://192.168.0.51',
		sshEnabled: true,
		requestTimeoutMs: 12_000,
	})

	expect(config.araknisSwitchBaseUrl).toBe('https://192.168.0.51')
	expect(config.araknisSwitchSshEnabled).toBe(true)
	expect(config.araknisSwitchRequestTimeoutMs).toBe(12_000)
	// Untouched field keeps env value.
	expect(config.araknisSwitchAllowInsecureTls).toBe(true)

	const after = await runtimeConfig.getIntegrationConfig('araknis_switch')
	expect(
		after.settings.find((setting) => setting.field === 'baseUrl')?.source,
	).toBe('stored')
	expect(
		after.settings.find((setting) => setting.field === 'sshEnabled')?.source,
	).toBe('stored')
	expect(
		after.settings.find((setting) => setting.field === 'allowInsecureTls')
			?.source,
	).toBe('env')

	await storage.close()
})

test('clearing stored settings restores env then default precedence', async () => {
	const { config, runtimeConfig, storage, disposeEnv } = await createService({
		ARAKNIS_SWITCH_BASE_URL: 'https://env-araknis.example',
		ARAKNIS_SWITCH_SSH_ENABLED: 'true',
		ARAKNIS_SWITCH_SSH_PORT: undefined,
	})
	using _env = disposeEnv

	await runtimeConfig.setIntegrationConfig('araknis_switch', {
		baseUrl: 'https://stored-araknis.example',
		sshPort: 2222,
	})
	expect(config.araknisSwitchBaseUrl).toBe('https://stored-araknis.example')
	expect(config.araknisSwitchSshPort).toBe(2222)

	await runtimeConfig.clearIntegrationConfig('araknis_switch', ['baseUrl'])
	expect(config.araknisSwitchBaseUrl).toBe('https://env-araknis.example')
	expect(config.araknisSwitchSshPort).toBe(2222)

	await runtimeConfig.clearIntegrationConfig('araknis_switch')
	expect(config.araknisSwitchBaseUrl).toBe('https://env-araknis.example')
	expect(config.araknisSwitchSshEnabled).toBe(true)
	expect(config.araknisSwitchSshPort).toBe(22)

	const snapshot = await runtimeConfig.getIntegrationConfig('araknis_switch')
	expect(
		snapshot.settings.find((setting) => setting.field === 'baseUrl')?.source,
	).toBe('env')
	expect(
		snapshot.settings.find((setting) => setting.field === 'sshPort')?.source,
	).toBe('default')

	await storage.close()
})

test('applyStoredOverrides reloads SQLite values on a fresh service', async () => {
	const first = await createService({
		ARAKNIS_SWITCH_ALLOW_INSECURE_TLS: 'false',
	})
	using _env = first.disposeEnv
	await first.runtimeConfig.setIntegrationConfig('araknis_switch', {
		allowInsecureTls: true,
		sshEnabled: true,
	})
	const snapshot =
		await first.runtimeConfig.getIntegrationConfig('araknis_switch')
	expect(
		snapshot.settings.find((setting) => setting.field === 'allowInsecureTls'),
	).toMatchObject({
		value: true,
		source: 'stored',
	})
	expect(
		snapshot.settings.find((setting) => setting.field === 'sshEnabled'),
	).toMatchObject({
		value: true,
		source: 'stored',
	})
	await first.storage.close()
})

test('araknis set_config rejects cleartext HTTP without allowInsecureTls', async () => {
	const { runtimeConfig, storage, disposeEnv } = await createService({
		ARAKNIS_SWITCH_ALLOW_INSECURE_TLS: 'false',
	})
	using _env = disposeEnv

	await expect(
		runtimeConfig.setIntegrationConfig('araknis_switch', {
			baseUrl: 'http://192.168.0.50',
		}),
	).rejects.toThrow(/https:\/\//)

	await runtimeConfig.setIntegrationConfig('araknis_switch', {
		baseUrl: 'http://192.168.0.50',
		allowInsecureTls: true,
	})
	const snapshot = await runtimeConfig.getIntegrationConfig('araknis_switch')
	expect(
		snapshot.settings.find((setting) => setting.field === 'baseUrl')?.value,
	).toBe('http://192.168.0.50')

	await storage.close()
})

test('set_config validates integers and unknown fields', async () => {
	const { runtimeConfig, storage, disposeEnv } = await createService()
	using _env = disposeEnv

	await expect(
		runtimeConfig.setIntegrationConfig('araknis_switch', {
			requestTimeoutMs: 50,
		}),
	).rejects.toThrow(/>= 1000/)

	await expect(
		runtimeConfig.setIntegrationConfig('araknis_switch', {
			notARealField: true,
		}),
	).rejects.toThrow(/Unknown araknis_switch config field/)

	await storage.close()
})

test('Unleashed and Island runtime settings round-trip through the store', async () => {
	const { config, runtimeConfig, storage, disposeEnv } = await createService({
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'false',
		ISLAND_ROUTER_HOST: 'router.env.local',
	})
	using _env = disposeEnv

	await runtimeConfig.setIntegrationConfig('access_networks_unleashed', {
		scanCidrs: ['192.168.10.88/32'],
		allowInsecureTls: true,
		requestTimeoutMs: 15_000,
	})
	await runtimeConfig.setIntegrationConfig('island_router', {
		host: 'router.stored.local',
		port: 2222,
		commandTimeoutMs: 9_000,
	})

	expect(config.accessNetworksUnleashedScanCidrs).toEqual(['192.168.10.88/32'])
	expect(config.accessNetworksUnleashedAllowInsecureTls).toBe(true)
	expect(config.accessNetworksUnleashedRequestTimeoutMs).toBe(15_000)
	expect(config.islandRouterHost).toBe('router.stored.local')
	expect(config.islandRouterPort).toBe(2222)
	expect(config.islandRouterCommandTimeoutMs).toBe(9_000)

	await storage.close()
})

test('clear_config with fields: [] clears nothing', async () => {
	const { config, runtimeConfig, storage, disposeEnv } = await createService()
	using _env = disposeEnv
	await runtimeConfig.setIntegrationConfig('araknis_switch', {
		sshEnabled: true,
	})
	await runtimeConfig.clearIntegrationConfig('araknis_switch', [])
	expect(config.araknisSwitchSshEnabled).toBe(true)
	const snapshot = await runtimeConfig.getIntegrationConfig('araknis_switch')
	expect(
		snapshot.settings.find((setting) => setting.field === 'sshEnabled')?.source,
	).toBe('stored')
	await storage.close()
})

test('get_config never exposes a secret-shaped value when none are defined', async () => {
	const { runtimeConfig, storage, disposeEnv } = await createService()
	using _env = disposeEnv
	const snapshot = await runtimeConfig.getIntegrationConfig('araknis_switch')
	for (const setting of snapshot.settings) {
		expect(setting).not.toHaveProperty('password')
		expect(String(setting.key)).not.toMatch(/password|secret|token/i)
	}
	expect(snapshot.precedence).toMatch(/stored runtime setting > env var/)
	await storage.close()
})

test('stored overrides survive a new storage open on the same SQLite file', async () => {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'home-connector-runtime-'))
	const dbPath = path.join(dataDir, 'home-connector.sqlite')
	try {
		const first = await createService({
			HOME_CONNECTOR_DB_PATH: dbPath,
			ARAKNIS_SWITCH_BASE_URL: 'https://env.example',
			ARAKNIS_SWITCH_SSH_ENABLED: 'false',
		})
		using _env = first.disposeEnv
		await first.runtimeConfig.setIntegrationConfig('araknis_switch', {
			baseUrl: 'https://persisted.example',
			sshEnabled: true,
		})
		await first.storage.close()

		const config = loadHomeConnectorConfig()
		const storage = await createHomeConnectorStorage(config)
		const runtimeConfig = createRuntimeConfigService({ config, storage })
		await runtimeConfig.applyStoredOverrides()

		expect(config.araknisSwitchBaseUrl).toBe('https://persisted.example')
		expect(config.araknisSwitchSshEnabled).toBe(true)
		const snapshot = await runtimeConfig.getIntegrationConfig('araknis_switch')
		expect(
			snapshot.settings.find((setting) => setting.field === 'baseUrl')?.source,
		).toBe('stored')
		await storage.close()
	} finally {
		rmSync(dataDir, { recursive: true, force: true })
	}
})
