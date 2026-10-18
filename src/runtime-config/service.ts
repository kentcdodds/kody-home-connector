import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorStorage } from '../storage/index.ts'
import {
	getRuntimeSettingDefinitionByField,
	listRuntimeSettingDefinitions,
	type RuntimeIntegrationId,
	type RuntimeSettingDefinition,
	type RuntimeSettingSource,
} from './definitions.ts'
import {
	deleteStoredRuntimeSetting,
	deleteStoredRuntimeSettingsForIntegration,
	listStoredRuntimeSettings,
	upsertStoredRuntimeSetting,
} from './repository.ts'
import {
	assertAraknisBaseUrlPolicy,
	validateRuntimeSettingValue,
} from './validation.ts'

export type RuntimeSettingView = {
	field: string
	key: string
	value: unknown
	/** Present for secret fields instead of the raw value. */
	configured?: boolean
	source: RuntimeSettingSource
	envVar: string
	description: string
	updatedAt?: string
}

export type RuntimeConfigService = {
	/** Env-only snapshot used when clearing a stored override. */
	envBaseline: Readonly<HomeConnectorConfig>
	/** Live mutable config shared with adapters. */
	config: HomeConnectorConfig
	applyStoredOverrides(): Promise<void>
	getIntegrationConfig(integration: RuntimeIntegrationId): Promise<{
		integration: RuntimeIntegrationId
		settings: Array<RuntimeSettingView>
		precedence: string
	}>
	setIntegrationConfig(
		integration: RuntimeIntegrationId,
		patch: Record<string, unknown>,
	): Promise<{
		integration: RuntimeIntegrationId
		updatedFields: Array<string>
		settings: Array<RuntimeSettingView>
	}>
	clearIntegrationConfig(
		integration: RuntimeIntegrationId,
		fields?: Array<string>,
	): Promise<{
		integration: RuntimeIntegrationId
		clearedFields: Array<string>
		settings: Array<RuntimeSettingView>
	}>
}

const PRECEDENCE_RULE =
	'stored runtime setting > env var > built-in default. Clearing a stored key falls back to env (if set) then the built-in default.'

function cloneConfig(config: HomeConnectorConfig): HomeConnectorConfig {
	return {
		...config,
		accessNetworksUnleashedScanCidrs: [
			...config.accessNetworksUnleashedScanCidrs,
		],
		kasaScanCidrs: [...config.kasaScanCidrs],
		pjlinkScanCidrs: [...config.pjlinkScanCidrs],
		pjlinkScanExtraHosts: [...config.pjlinkScanExtraHosts],
		courtBlurayScanExtraHosts: [...config.courtBlurayScanExtraHosts],
		courtBlurayScanCidrs: [...config.courtBlurayScanCidrs],
		venstarScanCidrs: [...config.venstarScanCidrs],
		jellyfishScanCidrs: [...config.jellyfishScanCidrs],
	}
}

function readConfigField(
	config: HomeConnectorConfig,
	definition: RuntimeSettingDefinition,
): unknown {
	return config[definition.configField as keyof HomeConnectorConfig]
}

function writeConfigField(
	config: HomeConnectorConfig,
	definition: RuntimeSettingDefinition,
	value: unknown,
) {
	const mutable = config as Record<string, unknown>
	mutable[definition.configField] = value
}

function valuesEqual(left: unknown, right: unknown) {
	return JSON.stringify(left) === JSON.stringify(right)
}

function resolveSource(input: {
	stored: boolean
	envBaseline: HomeConnectorConfig
	definition: RuntimeSettingDefinition
	effective: unknown
}): RuntimeSettingSource {
	if (input.stored) return 'stored'
	const envValue = readConfigField(input.envBaseline, input.definition)
	if (!valuesEqual(envValue, input.effective)) {
		// Should not happen for env-loaded config, but keep a safe fallback.
		return 'default'
	}
	// Distinguish env vs default by checking whether the env var is set.
	const rawEnv = process.env[input.definition.envVar]
	if (rawEnv != null && rawEnv !== '') return 'env'
	// Some env vars are meaningful when explicitly empty (PJLINK_SCAN_EXTRA_HOSTS='').
	if (rawEnv === '') return 'env'
	return 'default'
}

function toSettingView(input: {
	definition: RuntimeSettingDefinition
	effective: unknown
	source: RuntimeSettingSource
	updatedAt?: string
}): RuntimeSettingView {
	if (input.definition.secret) {
		return {
			field: input.definition.field,
			key: input.definition.key,
			value: null,
			configured: Boolean(input.effective),
			source: input.source,
			envVar: input.definition.envVar,
			description: input.definition.description,
			updatedAt: input.updatedAt,
		}
	}
	return {
		field: input.definition.field,
		key: input.definition.key,
		value: input.effective,
		source: input.source,
		envVar: input.definition.envVar,
		description: input.definition.description,
		updatedAt: input.updatedAt,
	}
}

export function createRuntimeConfigService(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
}): RuntimeConfigService {
	const envBaseline = Object.freeze(cloneConfig(input.config))
	const { config, storage } = input
	const connectorId = config.homeConnectorId

	async function applyStoredOverrides() {
		const rows = await listStoredRuntimeSettings(storage, connectorId)
		for (const row of rows) {
			const definition = listRuntimeSettingDefinitions().find(
				(entry) => entry.key === row.key,
			)
			if (!definition) continue
			if (definition.secret && row.value == null) continue
			writeConfigField(config, definition, row.value)
		}
	}

	async function getIntegrationConfig(integration: RuntimeIntegrationId) {
		const definitions = listRuntimeSettingDefinitions(integration)
		const storedRows = await listStoredRuntimeSettings(storage, connectorId)
		const storedByKey = new Map(storedRows.map((row) => [row.key, row]))
		const settings = definitions.map((definition) => {
			const stored = storedByKey.get(definition.key)
			const effective = readConfigField(config, definition)
			const source = resolveSource({
				stored: Boolean(stored),
				envBaseline,
				definition,
				effective,
			})
			return toSettingView({
				definition,
				effective,
				source,
				updatedAt: stored?.updatedAt,
			})
		})
		return {
			integration,
			settings,
			precedence: PRECEDENCE_RULE,
		}
	}

	async function setIntegrationConfig(
		integration: RuntimeIntegrationId,
		patch: Record<string, unknown>,
	) {
		const entries = Object.entries(patch).filter(
			([, value]) => value !== undefined,
		)
		if (entries.length === 0) {
			throw new Error('Provide at least one configuration field to update.')
		}

		const updatedFields: Array<string> = []
		const pendingWrites: Array<{
			definition: RuntimeSettingDefinition
			value: unknown
		}> = []

		for (const [field, rawValue] of entries) {
			const definition = getRuntimeSettingDefinitionByField(integration, field)
			if (!definition) {
				throw new Error(
					`Unknown ${integration} config field "${field}". Valid fields: ${listRuntimeSettingDefinitions(
						integration,
					)
						.map((entry) => entry.field)
						.join(', ')}.`,
				)
			}
			const value = validateRuntimeSettingValue(definition, rawValue)
			pendingWrites.push({ definition, value })
			updatedFields.push(field)
		}

		// Cross-field Araknis URL policy against the post-merge view.
		if (integration === 'araknis_switch') {
			const nextBaseUrl =
				(pendingWrites.find((entry) => entry.definition.field === 'baseUrl')
					?.value as string | undefined) ?? config.araknisSwitchBaseUrl
			const nextAllowInsecureTls =
				(pendingWrites.find(
					(entry) => entry.definition.field === 'allowInsecureTls',
				)?.value as boolean | undefined) ?? config.araknisSwitchAllowInsecureTls
			assertAraknisBaseUrlPolicy({
				baseUrl: nextBaseUrl,
				allowInsecureTls: nextAllowInsecureTls,
			})
		}

		for (const write of pendingWrites) {
			await upsertStoredRuntimeSetting({
				storage,
				connectorId,
				definition: write.definition,
				value: write.value,
			})
			writeConfigField(config, write.definition, write.value)
		}

		const snapshot = await getIntegrationConfig(integration)
		return {
			integration,
			updatedFields,
			settings: snapshot.settings,
		}
	}

	async function clearIntegrationConfig(
		integration: RuntimeIntegrationId,
		fields?: Array<string>,
	) {
		const definitions = listRuntimeSettingDefinitions(integration)
		let targets: Array<RuntimeSettingDefinition>
		if (fields === undefined) {
			targets = definitions
		} else if (fields.length === 0) {
			// Explicit empty selection clears nothing (do not treat as "all").
			targets = []
		} else {
			targets = fields.map((field) => {
				const definition = getRuntimeSettingDefinitionByField(
					integration,
					field,
				)
				if (!definition) {
					throw new Error(`Unknown ${integration} config field "${field}".`)
				}
				return definition
			})
		}

		if (integration === 'araknis_switch' && targets.length > 0) {
			const clearingBaseUrl = targets.some(
				(definition) => definition.field === 'baseUrl',
			)
			const clearingAllowInsecureTls = targets.some(
				(definition) => definition.field === 'allowInsecureTls',
			)
			assertAraknisBaseUrlPolicy({
				baseUrl: clearingBaseUrl
					? envBaseline.araknisSwitchBaseUrl
					: config.araknisSwitchBaseUrl,
				allowInsecureTls: clearingAllowInsecureTls
					? envBaseline.araknisSwitchAllowInsecureTls
					: config.araknisSwitchAllowInsecureTls,
			})
		}

		await deleteStoredRuntimeSettingsForIntegration({
			storage,
			connectorId,
			keys: targets.map((definition) => definition.key),
		})

		for (const definition of targets) {
			writeConfigField(
				config,
				definition,
				readConfigField(envBaseline, definition),
			)
		}

		const snapshot = await getIntegrationConfig(integration)
		return {
			integration,
			clearedFields: targets.map((definition) => definition.field),
			settings: snapshot.settings,
		}
	}

	return {
		envBaseline,
		config,
		applyStoredOverrides,
		getIntegrationConfig,
		setIntegrationConfig,
		clearIntegrationConfig,
	}
}

// Re-export for callers that only need to delete one key in tests.
export { deleteStoredRuntimeSetting }
