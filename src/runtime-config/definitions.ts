import { type HomeConnectorConfig } from '../config.ts'

export type RuntimeSettingKind =
	| 'string'
	| 'boolean'
	| 'integer'
	| 'string_list'
	| 'url'

export type RuntimeSettingSource = 'stored' | 'env' | 'default'

export type RuntimeIntegrationId =
	| 'araknis_switch'
	| 'access_networks_unleashed'
	| 'kasa'
	| 'island_router'
	| 'island_router_api'
	| 'global_cache'
	| 'court'
	| 'pjlink'
	| 'bluray'
	| 'bond'
	| 'venstar'
	| 'jellyfish'
	| 'discovery'
	| 'audiobook'

export type RuntimeConfigField = keyof HomeConnectorConfig

export type RuntimeSettingDefinition = {
	/** Stable storage key, e.g. `araknis_switch.base_url`. */
	key: string
	integration: RuntimeIntegrationId
	/** Tool argument name (camelCase) for set/get payloads. */
	field: string
	configField: RuntimeConfigField
	envVar: string
	kind: RuntimeSettingKind
	/**
	 * When true, values are encrypted at rest with HOME_CONNECTOR_SHARED_SECRET
	 * and never returned by get-config tools (only `configured: true/false`).
	 */
	secret?: boolean
	description: string
	integerMinimum?: number
	integerMaximum?: number
}

/**
 * Movable connector settings. Bootstrap-only env vars (data path, port,
 * encryption key, OAuth public URL, volume mounts, key file paths) are
 * intentionally absent.
 */
export const runtimeSettingDefinitions = [
	// Araknis AN-620
	{
		key: 'araknis_switch.base_url',
		integration: 'araknis_switch',
		field: 'baseUrl',
		configField: 'araknisSwitchBaseUrl',
		envVar: 'ARAKNIS_SWITCH_BASE_URL',
		kind: 'url',
		description: 'HTTPS base URL for the Araknis switch OpEN management API.',
	},
	{
		key: 'araknis_switch.allow_insecure_tls',
		integration: 'araknis_switch',
		field: 'allowInsecureTls',
		configField: 'araknisSwitchAllowInsecureTls',
		envVar: 'ARAKNIS_SWITCH_ALLOW_INSECURE_TLS',
		kind: 'boolean',
		description:
			'Allow self-signed / invalid TLS certificates for Araknis OpEN HTTPS.',
	},
	{
		key: 'araknis_switch.request_timeout_ms',
		integration: 'araknis_switch',
		field: 'requestTimeoutMs',
		configField: 'araknisSwitchRequestTimeoutMs',
		envVar: 'ARAKNIS_SWITCH_REQUEST_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 1000,
		description: 'Araknis OpEN/SSH request timeout in milliseconds.',
	},
	{
		key: 'araknis_switch.ssh_enabled',
		integration: 'araknis_switch',
		field: 'sshEnabled',
		configField: 'araknisSwitchSshEnabled',
		envVar: 'ARAKNIS_SWITCH_SSH_ENABLED',
		kind: 'boolean',
		description:
			'Enable SSH CLI fallback for PoE/LLDP when OpEN lacks those resources.',
	},
	{
		key: 'araknis_switch.ssh_port',
		integration: 'araknis_switch',
		field: 'sshPort',
		configField: 'araknisSwitchSshPort',
		envVar: 'ARAKNIS_SWITCH_SSH_PORT',
		kind: 'integer',
		integerMinimum: 1,
		integerMaximum: 65535,
		description: 'SSH port for Araknis CLI fallback.',
	},

	// Access Networks Unleashed
	{
		key: 'access_networks_unleashed.scan_cidrs',
		integration: 'access_networks_unleashed',
		field: 'scanCidrs',
		configField: 'accessNetworksUnleashedScanCidrs',
		envVar: 'ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS',
		kind: 'string_list',
		description:
			'CIDR list for Unleashed controller discovery. Empty means derive private /24s.',
	},
	{
		key: 'access_networks_unleashed.allow_insecure_tls',
		integration: 'access_networks_unleashed',
		field: 'allowInsecureTls',
		configField: 'accessNetworksUnleashedAllowInsecureTls',
		envVar: 'ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS',
		kind: 'boolean',
		description: 'Allow self-signed TLS for Unleashed HTTPS management.',
	},
	{
		key: 'access_networks_unleashed.request_timeout_ms',
		integration: 'access_networks_unleashed',
		field: 'requestTimeoutMs',
		configField: 'accessNetworksUnleashedRequestTimeoutMs',
		envVar: 'ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 1000,
		description: 'Unleashed HTTP request timeout in milliseconds.',
	},

	// Kasa (non-secret; username/password stay in kasa_credentials)
	{
		key: 'kasa.scan_cidrs',
		integration: 'kasa',
		field: 'scanCidrs',
		configField: 'kasaScanCidrs',
		envVar: 'KASA_SCAN_CIDRS',
		kind: 'string_list',
		description: 'CIDR list for Kasa KLAP plug discovery.',
	},
	{
		key: 'kasa.request_timeout_ms',
		integration: 'kasa',
		field: 'requestTimeoutMs',
		configField: 'kasaRequestTimeoutMs',
		envVar: 'KASA_REQUEST_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 1000,
		description: 'Kasa KLAP request timeout in milliseconds.',
	},

	// Island router SSH (non-path settings)
	{
		key: 'island_router.host',
		integration: 'island_router',
		field: 'host',
		configField: 'islandRouterHost',
		envVar: 'ISLAND_ROUTER_HOST',
		kind: 'string',
		description: 'Island router SSH hostname or IP.',
	},
	{
		key: 'island_router.port',
		integration: 'island_router',
		field: 'port',
		configField: 'islandRouterPort',
		envVar: 'ISLAND_ROUTER_PORT',
		kind: 'integer',
		integerMinimum: 1,
		integerMaximum: 65535,
		description: 'Island router SSH port.',
	},
	{
		key: 'island_router.username',
		integration: 'island_router',
		field: 'username',
		configField: 'islandRouterUsername',
		envVar: 'ISLAND_ROUTER_USERNAME',
		kind: 'string',
		description: 'Island router SSH username.',
	},
	{
		key: 'island_router.host_fingerprint',
		integration: 'island_router',
		field: 'hostFingerprint',
		configField: 'islandRouterHostFingerprint',
		envVar: 'ISLAND_ROUTER_HOST_FINGERPRINT',
		kind: 'string',
		description:
			'SSH host key fingerprint (SHA256:... or MD5:...). Prefer known_hosts path when mounted.',
	},
	{
		key: 'island_router.command_timeout_ms',
		integration: 'island_router',
		field: 'commandTimeoutMs',
		configField: 'islandRouterCommandTimeoutMs',
		envVar: 'ISLAND_ROUTER_COMMAND_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 1000,
		description: 'Island SSH command timeout in milliseconds.',
	},

	// Island Router HTTPS API
	{
		key: 'island_router_api.base_url',
		integration: 'island_router_api',
		field: 'baseUrl',
		configField: 'islandRouterApiBaseUrl',
		envVar: 'ISLAND_ROUTER_API_BASE_URL',
		kind: 'url',
		description: 'Island Router cloud/LAN HTTPS API base URL.',
	},
	{
		key: 'island_router_api.request_timeout_ms',
		integration: 'island_router_api',
		field: 'requestTimeoutMs',
		configField: 'islandRouterApiRequestTimeoutMs',
		envVar: 'ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 1000,
		description: 'Island Router API request timeout in milliseconds.',
	},
	{
		key: 'island_router_api.allow_insecure_tls',
		integration: 'island_router_api',
		field: 'allowInsecureTls',
		configField: 'islandRouterApiAllowInsecureTls',
		envVar: 'ISLAND_ROUTER_API_ALLOW_INSECURE_TLS',
		kind: 'boolean',
		description: 'Allow self-signed TLS for Island Router API HTTPS.',
	},

	// Global Cache / court iTach
	{
		key: 'global_cache.host',
		integration: 'global_cache',
		field: 'host',
		configField: 'globalCacheHost',
		envVar: 'GLOBAL_CACHE_HOST',
		kind: 'string',
		description: 'Global Cache iTach IP2IR host.',
	},
	{
		key: 'global_cache.port',
		integration: 'global_cache',
		field: 'port',
		configField: 'globalCachePort',
		envVar: 'GLOBAL_CACHE_PORT',
		kind: 'integer',
		integerMinimum: 1,
		integerMaximum: 65535,
		description: 'Global Cache iTach TCP port.',
	},

	// Court AV pins / timeouts
	{
		key: 'court.roku_device_id',
		integration: 'court',
		field: 'rokuDeviceId',
		configField: 'courtRokuDeviceId',
		envVar: 'COURT_ROKU_DEVICE_ID',
		kind: 'string',
		description: 'Adopted Court Roku device id pin.',
	},
	{
		key: 'court.sonos_player_id',
		integration: 'court',
		field: 'sonosPlayerId',
		configField: 'courtSonosPlayerId',
		envVar: 'COURT_SONOS_PLAYER_ID',
		kind: 'string',
		description: 'Adopted Sport Court Sonos player id pin.',
	},
	{
		key: 'court.pjlink_projector_id',
		integration: 'court',
		field: 'pjlinkProjectorId',
		configField: 'courtPjlinkProjectorId',
		envVar: 'COURT_PJLINK_PROJECTOR_ID',
		kind: 'string',
		description: 'Adopted court Optoma PJLink projector id pin.',
	},
	{
		key: 'court.pjlink_timeout_ms',
		integration: 'court',
		field: 'pjlinkTimeoutMs',
		configField: 'courtPjlinkTimeoutMs',
		envVar: 'COURT_PJLINK_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 250,
		description:
			'Short PJLink timeout for court power tools (fail fast into IR).',
	},

	// Blu-ray (non-secret; cookie/psk stay env fallback or adopted rows)
	{
		key: 'bluray.host',
		integration: 'bluray',
		field: 'host',
		configField: 'courtBlurayHost',
		envVar: 'COURT_BLURAY_HOST',
		kind: 'string',
		description: 'Court Sony UHD Blu-ray IRCC host. Empty when unplugged.',
	},
	{
		key: 'bluray.mac_address',
		integration: 'bluray',
		field: 'macAddress',
		configField: 'courtBlurayMacAddress',
		envVar: 'COURT_BLURAY_MAC',
		kind: 'string',
		description: 'Court Blu-ray MAC for WoL.',
	},
	{
		key: 'bluray.timeout_ms',
		integration: 'bluray',
		field: 'timeoutMs',
		configField: 'courtBlurayTimeoutMs',
		envVar: 'COURT_BLURAY_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 250,
		description: 'Blu-ray IRCC probe/send timeout in milliseconds.',
	},
	{
		key: 'bluray.scan_extra_hosts',
		integration: 'bluray',
		field: 'scanExtraHosts',
		configField: 'courtBlurayScanExtraHosts',
		envVar: 'COURT_BLURAY_SCAN_EXTRA_HOSTS',
		kind: 'string_list',
		description: 'Extra hosts always probed by bluray_scan.',
	},
	{
		key: 'bluray.scan_cidrs',
		integration: 'bluray',
		field: 'scanCidrs',
		configField: 'courtBlurayScanCidrs',
		envVar: 'COURT_BLURAY_SCAN_CIDRS',
		kind: 'string_list',
		description: 'Optional CIDR list for bluray_scan (default empty).',
	},

	// PJLink
	{
		key: 'pjlink.scan_cidrs',
		integration: 'pjlink',
		field: 'scanCidrs',
		configField: 'pjlinkScanCidrs',
		envVar: 'PJLINK_SCAN_CIDRS',
		kind: 'string_list',
		description: 'CIDR list for PJLink Class 1 discovery.',
	},
	{
		key: 'pjlink.scan_extra_hosts',
		integration: 'pjlink',
		field: 'scanExtraHosts',
		configField: 'pjlinkScanExtraHosts',
		envVar: 'PJLINK_SCAN_EXTRA_HOSTS',
		kind: 'string_list',
		description: 'Extra hosts always probed during PJLink scans.',
	},
	{
		key: 'pjlink.request_timeout_ms',
		integration: 'pjlink',
		field: 'requestTimeoutMs',
		configField: 'pjlinkRequestTimeoutMs',
		envVar: 'PJLINK_REQUEST_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 1000,
		description: 'PJLink TCP request timeout in milliseconds.',
	},

	// Bond
	{
		key: 'bond.request_pace_ms',
		integration: 'bond',
		field: 'requestPaceMs',
		configField: 'bondRequestPaceMs',
		envVar: 'BOND_REQUEST_PACE_MS',
		kind: 'integer',
		integerMinimum: 0,
		description: 'Minimum spacing between Bond HTTP requests.',
	},
	{
		key: 'bond.circuit_breaker_cooldown_ms',
		integration: 'bond',
		field: 'circuitBreakerCooldownMs',
		configField: 'bondCircuitBreakerCooldownMs',
		envVar: 'BOND_CIRCUIT_BREAKER_COOLDOWN_MS',
		kind: 'integer',
		integerMinimum: 0,
		description: 'Bond circuit-breaker cooldown after network failures.',
	},

	// Venstar / JellyFish scan
	{
		key: 'venstar.scan_cidrs',
		integration: 'venstar',
		field: 'scanCidrs',
		configField: 'venstarScanCidrs',
		envVar: 'VENSTAR_SCAN_CIDRS',
		kind: 'string_list',
		description: 'CIDR list for Venstar thermostat discovery.',
	},
	{
		key: 'jellyfish.scan_cidrs',
		integration: 'jellyfish',
		field: 'scanCidrs',
		configField: 'jellyfishScanCidrs',
		envVar: 'JELLYFISH_SCAN_CIDRS',
		kind: 'string_list',
		description: 'CIDR list for JellyFish controller discovery.',
	},

	// Discovery URL overrides
	{
		key: 'discovery.roku_url',
		integration: 'discovery',
		field: 'rokuDiscoveryUrl',
		configField: 'rokuDiscoveryUrl',
		envVar: 'ROKU_DISCOVERY_URL',
		kind: 'string',
		description: 'Roku SSDP/discovery URL override (mocks use HTTP feeds).',
	},
	{
		key: 'discovery.samsung_tv_url',
		integration: 'discovery',
		field: 'samsungTvDiscoveryUrl',
		configField: 'samsungTvDiscoveryUrl',
		envVar: 'SAMSUNG_TV_DISCOVERY_URL',
		kind: 'string',
		description: 'Samsung TV mDNS/discovery URL override.',
	},
	{
		key: 'discovery.lutron_url',
		integration: 'discovery',
		field: 'lutronDiscoveryUrl',
		configField: 'lutronDiscoveryUrl',
		envVar: 'LUTRON_DISCOVERY_URL',
		kind: 'string',
		description: 'Lutron mDNS/discovery URL override.',
	},
	{
		key: 'discovery.sonos_url',
		integration: 'discovery',
		field: 'sonosDiscoveryUrl',
		configField: 'sonosDiscoveryUrl',
		envVar: 'SONOS_DISCOVERY_URL',
		kind: 'string',
		description: 'Sonos SSDP/discovery URL override.',
	},
	{
		key: 'discovery.bond_url',
		integration: 'discovery',
		field: 'bondDiscoveryUrl',
		configField: 'bondDiscoveryUrl',
		envVar: 'BOND_DISCOVERY_URL',
		kind: 'string',
		description: 'Bond mDNS/discovery URL override.',
	},
	{
		key: 'discovery.jellyfish_url',
		integration: 'discovery',
		field: 'jellyfishDiscoveryUrl',
		configField: 'jellyfishDiscoveryUrl',
		envVar: 'JELLYFISH_DISCOVERY_URL',
		kind: 'string',
		description:
			'Optional JellyFish JSON discovery feed URL. Empty uses CIDR scan.',
	},

	// Audiobook (timeout only; library path stays env for volume mounts)
	{
		key: 'audiobook.import_timeout_ms',
		integration: 'audiobook',
		field: 'importTimeoutMs',
		configField: 'audiobookImportTimeoutMs',
		envVar: 'AUDIOBOOK_IMPORT_TIMEOUT_MS',
		kind: 'integer',
		integerMinimum: 5_000,
		description: 'Audiobook import/ffmpeg job timeout in milliseconds.',
	},
] as const satisfies ReadonlyArray<RuntimeSettingDefinition>

export type RuntimeSettingKey =
	(typeof runtimeSettingDefinitions)[number]['key']

export function listRuntimeSettingDefinitions(
	integration?: RuntimeIntegrationId,
): Array<RuntimeSettingDefinition> {
	if (!integration) return [...runtimeSettingDefinitions]
	return runtimeSettingDefinitions.filter(
		(definition) => definition.integration === integration,
	)
}

export function getRuntimeSettingDefinition(
	key: string,
): RuntimeSettingDefinition | null {
	return (
		runtimeSettingDefinitions.find((definition) => definition.key === key) ??
		null
	)
}

export function getRuntimeSettingDefinitionByField(
	integration: RuntimeIntegrationId,
	field: string,
): RuntimeSettingDefinition | null {
	return (
		runtimeSettingDefinitions.find(
			(definition) =>
				definition.integration === integration && definition.field === field,
		) ?? null
	)
}

export const runtimeIntegrationToolPrefixes: Record<
	RuntimeIntegrationId,
	string
> = {
	araknis_switch: 'araknis',
	access_networks_unleashed: 'access_networks_unleashed',
	kasa: 'kasa',
	island_router: 'island_router',
	island_router_api: 'island_router_api',
	global_cache: 'global_cache',
	court: 'court',
	pjlink: 'pjlink',
	bluray: 'bluray',
	bond: 'bond',
	venstar: 'venstar',
	jellyfish: 'jellyfish',
	discovery: 'discovery',
	audiobook: 'audiobook',
}
