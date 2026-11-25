CREATE TABLE IF NOT EXISTS sonos_spotify_service_cache (
	connector_id TEXT NOT NULL PRIMARY KEY,
	sid TEXT NOT NULL,
	sn TEXT NOT NULL,
	desc_token TEXT NOT NULL,
	source TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
