CREATE TABLE IF NOT EXISTS connector_runtime_settings (
	connector_id TEXT NOT NULL,
	setting_key TEXT NOT NULL,
	value_json TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (connector_id, setting_key)
);
