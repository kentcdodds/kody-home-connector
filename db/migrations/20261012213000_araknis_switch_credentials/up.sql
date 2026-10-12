CREATE TABLE IF NOT EXISTS araknis_switch_credentials (
	connector_id TEXT NOT NULL PRIMARY KEY,
	username TEXT NOT NULL,
	password TEXT NOT NULL,
	last_authenticated_at TEXT,
	last_auth_error TEXT,
	updated_at TEXT NOT NULL
);
