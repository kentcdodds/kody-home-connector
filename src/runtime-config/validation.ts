import {
	type RuntimeSettingDefinition,
	type RuntimeSettingKind,
} from './definitions.ts'

function trimTrailingSlash(value: string) {
	let trimmed = value
	while (trimmed.endsWith('/')) {
		trimmed = trimmed.slice(0, -1)
	}
	return trimmed
}

function parseBoolean(value: unknown, field: string): boolean {
	if (typeof value === 'boolean') return value
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase()
		if (normalized === 'true' || normalized === '1') return true
		if (normalized === 'false' || normalized === '0') return false
	}
	throw new Error(`${field} must be a boolean (true/false).`)
}

function parseInteger(value: unknown, definition: RuntimeSettingDefinition) {
	const field = definition.field
	let parsed: number
	if (typeof value === 'number') {
		parsed = value
	} else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
		parsed = Number.parseInt(value.trim(), 10)
	} else {
		throw new Error(`${field} must be an integer.`)
	}
	if (!Number.isInteger(parsed)) {
		throw new Error(`${field} must be an integer.`)
	}
	if (definition.integerMinimum != null && parsed < definition.integerMinimum) {
		throw new Error(`${field} must be >= ${String(definition.integerMinimum)}.`)
	}
	if (definition.integerMaximum != null && parsed > definition.integerMaximum) {
		throw new Error(`${field} must be <= ${String(definition.integerMaximum)}.`)
	}
	return parsed
}

function parseStringList(
	value: unknown,
	field: string,
	options?: { allowEmpty?: boolean },
): Array<string> {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			if (options?.allowEmpty) return []
			throw new Error(
				`${field} must not be empty. Call clear_config for that field to restore env/autoscan defaults.`,
			)
		}
		return value.map((entry, index) => {
			if (typeof entry !== 'string' || !entry.trim()) {
				throw new Error(
					`${field}[${String(index)}] must be a non-empty string.`,
				)
			}
			return entry.trim()
		})
	}
	if (typeof value === 'string') {
		const parsed = value
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
		if (parsed.length === 0 && !options?.allowEmpty) {
			throw new Error(
				`${field} must not be empty. Call clear_config for that field to restore env/autoscan defaults.`,
			)
		}
		return parsed
	}
	throw new Error(`${field} must be a string list or comma-separated string.`)
}

function parseUrl(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${field} must be a non-empty URL string.`)
	}
	const trimmed = trimTrailingSlash(value.trim())
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new Error(`${field} must be a valid URL.`)
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`${field} must use http:// or https://.`)
	}
	return trimmed
}

function parseNullableString(value: unknown, field: string): string | null {
	if (value === null || value === undefined) return null
	if (typeof value !== 'string') {
		throw new Error(`${field} must be a string or null.`)
	}
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

function parseString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${field} must be a string.`)
	}
	return value.trim()
}

export function validateRuntimeSettingValue(
	definition: RuntimeSettingDefinition,
	rawValue: unknown,
): unknown {
	const field = definition.field
	switch (definition.kind as RuntimeSettingKind) {
		case 'boolean':
			return parseBoolean(rawValue, field)
		case 'integer':
			return parseInteger(rawValue, definition)
		case 'string_list': {
			const allowEmpty =
				definition.configField === 'pjlinkScanExtraHosts' ||
				definition.configField === 'courtBlurayScanExtraHosts' ||
				definition.configField === 'courtBlurayScanCidrs'
			return parseStringList(rawValue, field, { allowEmpty })
		}
		case 'url': {
			const url = parseUrl(rawValue, field)
			if (
				definition.key === 'araknis_switch.base_url' &&
				/^http:\/\//i.test(url)
			) {
				// Cleartext HTTP is refused unless allow_insecure_tls is also set;
				// that cross-field check happens in the service after merge.
			}
			return url
		}
		case 'string': {
			// Nullable config fields accept empty → null.
			const nullableFields = new Set<string>([
				'islandRouterHost',
				'islandRouterUsername',
				'islandRouterHostFingerprint',
				'courtRokuDeviceId',
				'courtSonosPlayerId',
				'courtPjlinkProjectorId',
				'courtBlurayHost',
				'courtBlurayMacAddress',
				'jellyfishDiscoveryUrl',
			])
			if (nullableFields.has(definition.configField)) {
				return parseNullableString(rawValue, field)
			}
			const value = parseString(rawValue, field)
			if (!value) {
				throw new Error(`${field} must not be empty.`)
			}
			return value
		}
		default: {
			const _exhaustive: never = definition.kind as never
			throw new Error(`Unhandled runtime setting kind: ${String(_exhaustive)}`)
		}
	}
}

export function assertAraknisBaseUrlPolicy(input: {
	baseUrl: string
	allowInsecureTls: boolean
}) {
	if (/^http:\/\//i.test(input.baseUrl) && !input.allowInsecureTls) {
		throw new Error(
			'baseUrl must use https:// (cleartext HTTP would send the switch password unencrypted). Set allowInsecureTls=true only for a deliberate LAN exception.',
		)
	}
}
