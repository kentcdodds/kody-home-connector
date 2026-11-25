DROP TABLE IF EXISTS sonos_spotify_service_cache;
CREATE TABLE sonos_spotify_service_cache (
	connector_id TEXT NOT NULL,
	household_id TEXT NOT NULL,
	sid TEXT NOT NULL,
	sn TEXT NOT NULL,
	desc_token TEXT NOT NULL,
	source TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (connector_id, household_id)
);
