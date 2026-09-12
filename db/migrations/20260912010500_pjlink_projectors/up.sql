CREATE TABLE IF NOT EXISTS pjlink_projectors (
	connector_id TEXT NOT NULL,
	projector_id TEXT NOT NULL,
	name TEXT NOT NULL,
	host TEXT NOT NULL,
	port INTEGER NOT NULL,
	mac_address TEXT,
	manufacturer TEXT,
	model TEXT,
	auth_required INTEGER NOT NULL DEFAULT 0,
	password TEXT,
	adopted INTEGER NOT NULL DEFAULT 0,
	raw_discovery_json TEXT,
	last_seen_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (connector_id, projector_id)
);
