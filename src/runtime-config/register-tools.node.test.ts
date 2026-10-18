import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../config.ts'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { registerRuntimeConfigHomeConnectorTools } from './register-tools.ts'
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

test('registers get/set/clear config tools for Araknis and applies via MCP handlers', async () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ARAKNIS_SWITCH_BASE_URL: 'https://192.168.0.50',
		ARAKNIS_SWITCH_ALLOW_INSECURE_TLS: 'true',
	})
	const config = loadHomeConnectorConfig()
	const storage = await createHomeConnectorStorage(config)
	const runtimeConfig = createRuntimeConfigService({ config, storage })
	await runtimeConfig.applyStoredOverrides()

	const tools = new Map<
		string,
		{ handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
	>()

	registerRuntimeConfigHomeConnectorTools({
		integrations: ['araknis_switch'],
		runtimeConfig,
		registerTool(descriptor, handler) {
			tools.set(descriptor.name, { handler })
		},
	})

	expect([...tools.keys()].sort()).toEqual([
		'araknis_clear_config',
		'araknis_get_config',
		'araknis_set_config',
	])

	const setResult = await tools.get('araknis_set_config')!.handler({
		baseUrl: 'https://192.168.0.60',
		sshEnabled: true,
	})
	expect(setResult.isError).toBeFalsy()
	expect(config.araknisSwitchBaseUrl).toBe('https://192.168.0.60')
	expect(config.araknisSwitchSshEnabled).toBe(true)

	const getResult = await tools.get('araknis_get_config')!.handler({})
	const settings = (
		getResult.structuredContent as {
			settings: Array<{ field: string; source: string; value: unknown }>
		}
	).settings
	expect(settings.find((setting) => setting.field === 'baseUrl')).toMatchObject(
		{
			value: 'https://192.168.0.60',
			source: 'stored',
		},
	)
	expect(
		settings.find((setting) => setting.field === 'allowInsecureTls'),
	).toMatchObject({
		value: true,
		source: 'env',
	})

	const clearResult = await tools.get('araknis_clear_config')!.handler({
		fields: ['baseUrl'],
	})
	expect(clearResult.isError).toBeFalsy()
	expect(config.araknisSwitchBaseUrl).toBe('https://192.168.0.50')
	expect(config.araknisSwitchSshEnabled).toBe(true)

	await storage.close()
})

test('araknis_set_config returns a structured validation error', async () => {
	using _env = createTemporaryEnv(requiredConfigEnv)
	const config = loadHomeConnectorConfig()
	const storage = await createHomeConnectorStorage(config)
	const runtimeConfig = createRuntimeConfigService({ config, storage })

	const tools = new Map<
		string,
		{ handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
	>()
	registerRuntimeConfigHomeConnectorTools({
		integrations: ['araknis_switch'],
		runtimeConfig,
		registerTool(descriptor, handler) {
			tools.set(descriptor.name, { handler })
		},
	})

	const result = await tools.get('araknis_set_config')!.handler({
		requestTimeoutMs: 10,
	})
	expect(result.isError).toBe(true)
	expect(result.structuredContent).toMatchObject({
		error: {
			code: 'invalid_runtime_config',
		},
	})

	await storage.close()
})
