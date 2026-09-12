CREATE TABLE IF NOT EXISTS sony_ircc_players (
	connector_id TEXT NOT NULL,
	player_id TEXT NOT NULL,
	name TEXT NOT NULL,
	host TEXT NOT NULL,
	mac_address TEXT,
	model TEXT,
	manufacturer TEXT,
	ircc_control_url TEXT,
	auth_cookie TEXT,
	auth_psk TEXT,
	adopted INTEGER NOT NULL DEFAULT 0,
	raw_probe_json TEXT,
	last_seen_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (connector_id, player_id)
);
