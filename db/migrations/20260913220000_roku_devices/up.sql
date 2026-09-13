CREATE TABLE IF NOT EXISTS roku_devices (
	connector_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	roku_id TEXT NOT NULL,
	name TEXT NOT NULL,
	location TEXT NOT NULL,
	serial_number TEXT,
	model_name TEXT,
	adopted INTEGER NOT NULL DEFAULT 0,
	control_enabled INTEGER NOT NULL DEFAULT 1,
	last_seen_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (connector_id, device_id)
);
