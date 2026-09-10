import { get, route } from 'remix/routes'

// Pages that only render are GET routes, so the router serves HEAD for them and
// answers other methods with 405. Pages whose single action also processes
// POST form submissions stay method-agnostic.
export const routes = route({
	home: get('/'),
	systemStatus: get('/system-status'),
	diagnostics: get('/diagnostics'),
	islandRouterStatus: get('/island-router/status'),
	islandRouterApiStatus: get('/island-router-api/status'),
	islandRouterApiSetup: '/island-router-api/setup',
	health: get('/health'),
	rokuStatus: '/roku/status',
	rokuSetup: get('/roku/setup'),
	lutronStatus: '/lutron/status',
	lutronSetup: get('/lutron/setup'),
	sonosStatus: '/sonos/status',
	sonosSetup: get('/sonos/setup'),
	samsungTvStatus: '/samsung-tv/status',
	samsungTvSetup: get('/samsung-tv/setup'),
	bondStatus: '/bond/status',
	bondSetup: '/bond/setup',
	accessNetworksUnleashedStatus: '/access-networks-unleashed/status',
	accessNetworksUnleashedSetup: '/access-networks-unleashed/setup',
	kasaStatus: '/kasa/status',
	kasaSetup: '/kasa/setup',
	phoneStatus: get('/phone/status'),
	phoneSetup: '/phone/setup',
	jellyfishStatus: '/jellyfish/status',
	jellyfishSetup: get('/jellyfish/setup'),
	venstarStatus: '/venstar/status',
	venstarSetup: '/venstar/setup',
})
