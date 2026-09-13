import { column as c, table } from 'remix/data-table'

// Column definitions mirror db/migrations; `updated_at` is touched automatically
// on write by data-table (see `timestamps` below). Schema changes belong in a new
// migration under db/migrations, then here.

const timestamps = true

export const samsungTvs = table({
	name: 'samsung_tvs',
	columns: {
		connector_id: c.text(),
		device_id: c.text(),
		host: c.text(),
		name: c.text(),
		service_url: c.text().nullable(),
		model: c.text().nullable(),
		model_name: c.text().nullable(),
		mac_address: c.text().nullable(),
		frame_tv_support: c.integer(),
		token_auth_support: c.integer(),
		power_state: c.text().nullable(),
		raw_device_info_json: c.text().nullable(),
		adopted: c.integer(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'device_id'],
	timestamps,
})

export const samsungTokens = table({
	name: 'samsung_tokens',
	columns: {
		connector_id: c.text(),
		device_id: c.text(),
		token: c.text(),
		last_verified_at: c.text().nullable(),
		last_auth_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'device_id'],
	timestamps,
})

export const lutronProcessors = table({
	name: 'lutron_processors',
	columns: {
		connector_id: c.text(),
		processor_id: c.text(),
		instance_name: c.text(),
		name: c.text(),
		host: c.text(),
		port: c.integer(),
		discovery_port: c.integer().nullable(),
		address: c.text().nullable(),
		serial_number: c.text().nullable(),
		mac_address: c.text().nullable(),
		system_type: c.text().nullable(),
		code_version: c.text().nullable(),
		device_class: c.text().nullable(),
		claim_status: c.text().nullable(),
		network_status: c.text().nullable(),
		firmware_status: c.text().nullable(),
		status: c.text().nullable(),
		raw_discovery_json: c.text().nullable(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'processor_id'],
	timestamps,
})

export const lutronCredentials = table({
	name: 'lutron_credentials',
	columns: {
		connector_id: c.text(),
		processor_id: c.text(),
		username: c.text(),
		password: c.text(),
		last_authenticated_at: c.text().nullable(),
		last_auth_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'processor_id'],
	timestamps,
})

export const bondBridges = table({
	name: 'bond_bridges',
	columns: {
		connector_id: c.text(),
		bridge_id: c.text(),
		bondid: c.text(),
		instance_name: c.text(),
		host: c.text(),
		port: c.integer(),
		model: c.text().nullable(),
		fw_ver: c.text().nullable(),
		raw_discovery_json: c.text().nullable(),
		adopted: c.integer(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'bridge_id'],
	timestamps,
})

export const bondTokens = table({
	name: 'bond_tokens',
	columns: {
		connector_id: c.text(),
		bridge_id: c.text(),
		token: c.text(),
		last_verified_at: c.text().nullable(),
		last_auth_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'bridge_id'],
	timestamps,
})

export const bondRequestLogs = table({
	name: 'bond_request_logs',
	columns: {
		id: c.integer().autoIncrement(),
		connector_id: c.text(),
		bridge_id: c.text(),
		operation: c.text(),
		status: c.text(),
		started_at: c.text(),
		finished_at: c.text(),
		duration_ms: c.integer(),
		base_urls_tried_json: c.text().nullable(),
		error_name: c.text().nullable(),
		error_message: c.text().nullable(),
		network_failure: c.integer(),
		created_at: c.text(),
	},
	primaryKey: ['id'],
	timestamps,
})

export const bondReliabilityState = table({
	name: 'bond_reliability_state',
	columns: {
		connector_id: c.text(),
		bridge_id: c.text(),
		cooldown_until: c.text().nullable(),
		last_failure_at: c.text().nullable(),
		last_failure_reason: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'bridge_id'],
	timestamps,
})

export const jellyfishControllers = table({
	name: 'jellyfish_controllers',
	columns: {
		connector_id: c.text(),
		controller_id: c.text(),
		name: c.text(),
		hostname: c.text(),
		host: c.text(),
		port: c.integer(),
		firmware_version: c.text().nullable(),
		last_seen_at: c.text().nullable(),
		last_connected_at: c.text().nullable(),
		last_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'controller_id'],
	timestamps,
})

export const accessNetworksUnleashedControllers = table({
	name: 'access_networks_unleashed_controllers',
	columns: {
		connector_id: c.text(),
		controller_id: c.text(),
		name: c.text(),
		host: c.text(),
		login_url: c.text(),
		raw_discovery_json: c.text().nullable(),
		adopted: c.integer(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'controller_id'],
	timestamps,
})

export const accessNetworksUnleashedCredentials = table({
	name: 'access_networks_unleashed_credentials',
	columns: {
		connector_id: c.text(),
		controller_id: c.text(),
		username: c.text(),
		password: c.text(),
		last_authenticated_at: c.text().nullable(),
		last_auth_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'controller_id'],
	timestamps,
})

export const kasaPlugs = table({
	name: 'kasa_plugs',
	columns: {
		connector_id: c.text(),
		plug_id: c.text(),
		alias: c.text(),
		host: c.text(),
		port: c.integer(),
		model: c.text().nullable(),
		mac: c.text().nullable(),
		device_id: c.text().nullable(),
		relay_state: c.text().nullable(),
		adopted: c.integer(),
		raw_sysinfo_json: c.text().nullable(),
		raw_discovery_json: c.text().nullable(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'plug_id'],
	timestamps,
})

export const kasaCredentials = table({
	name: 'kasa_credentials',
	columns: {
		connector_id: c.text(),
		username: c.text(),
		password: c.text(),
		last_authenticated_at: c.text().nullable(),
		last_auth_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id'],
	timestamps,
})

export const islandRouterApiCredentials = table({
	name: 'island_router_api_credentials',
	columns: {
		connector_id: c.text(),
		pin: c.text(),
		last_authenticated_at: c.text().nullable(),
		last_auth_error: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id'],
	timestamps,
})

export const phoneDeviceTokens = table({
	name: 'phone_device_tokens',
	columns: {
		connector_id: c.text(),
		token: c.text(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id'],
	timestamps,
})

export const sonosPlayers = table({
	name: 'sonos_players',
	columns: {
		connector_id: c.text(),
		player_id: c.text(),
		udn: c.text(),
		room_name: c.text(),
		display_name: c.text().nullable(),
		friendly_name: c.text(),
		model_name: c.text().nullable(),
		model_number: c.text().nullable(),
		serial_num: c.text().nullable(),
		household_id: c.text().nullable(),
		host: c.text(),
		description_url: c.text(),
		audio_input_supported: c.integer(),
		adopted: c.integer(),
		last_seen_at: c.text().nullable(),
		raw_description_xml: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'player_id'],
	timestamps,
})

export const sonyIrccPlayers = table({
	name: 'sony_ircc_players',
	columns: {
		connector_id: c.text(),
		player_id: c.text(),
		name: c.text(),
		host: c.text(),
		mac_address: c.text().nullable(),
		model: c.text().nullable(),
		manufacturer: c.text().nullable(),
		ircc_control_url: c.text().nullable(),
		auth_cookie: c.text().nullable(),
		auth_psk: c.text().nullable(),
		adopted: c.integer(),
		raw_probe_json: c.text().nullable(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'player_id'],
	timestamps,
})

export const pjlinkProjectors = table({
	name: 'pjlink_projectors',
	columns: {
		connector_id: c.text(),
		projector_id: c.text(),
		name: c.text(),
		host: c.text(),
		port: c.integer(),
		mac_address: c.text().nullable(),
		manufacturer: c.text().nullable(),
		model: c.text().nullable(),
		auth_required: c.integer(),
		password: c.text().nullable(),
		adopted: c.integer(),
		raw_discovery_json: c.text().nullable(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'projector_id'],
	timestamps,
})

export const rokuDevices = table({
	name: 'roku_devices',
	columns: {
		connector_id: c.text(),
		device_id: c.text(),
		roku_id: c.text(),
		name: c.text(),
		location: c.text(),
		serial_number: c.text().nullable(),
		model_name: c.text().nullable(),
		adopted: c.integer(),
		control_enabled: c.integer(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'device_id'],
	timestamps,
})

export const venstarThermostats = table({
	name: 'venstar_thermostats',
	columns: {
		connector_id: c.text(),
		ip: c.text(),
		name: c.text(),
		last_seen_at: c.text().nullable(),
		updated_at: c.text(),
	},
	primaryKey: ['connector_id', 'ip'],
	timestamps,
})

export const homeConnectorLogs = table({
	name: 'home_connector_logs',
	columns: {
		id: c.integer().autoIncrement(),
		connector_id: c.text(),
		level: c.text(),
		event: c.text(),
		message: c.text(),
		metadata_json: c.text(),
		created_at: c.text(),
	},
	primaryKey: ['id'],
})

export const oauthAuthorizationCodes = table({
	name: 'oauth_authorization_codes',
	columns: {
		code_hash: c.text(),
		client_id: c.text(),
		redirect_uri: c.text(),
		code_challenge: c.text(),
		code_challenge_method: c.text(),
		resource: c.text(),
		scope: c.text(),
		expires_at: c.integer(),
		consumed_at: c.integer().nullable(),
	},
	primaryKey: ['code_hash'],
})

export const oauthTokens = table({
	name: 'oauth_tokens',
	columns: {
		token_hash: c.text(),
		token_kind: c.enum(['access', 'refresh'] as const),
		client_id: c.text(),
		resource: c.text(),
		scope: c.text(),
		expires_at: c.integer(),
		revoked_at: c.integer().nullable(),
	},
	primaryKey: ['token_hash'],
})
