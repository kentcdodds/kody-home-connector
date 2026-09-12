import { afterEach, expect, test, vi } from 'vitest'
import {
	addSonosUriToQueueLive,
	createSonosFavoriteLive,
	playSonosLive,
	removeSonosQueueTrackRangeLive,
	seekSonosQueueTrackLive,
	selectSonosAudioInputLive,
	selectSonosTvInputLive,
	setSonosTransportUriLive,
	setSonosVolumeLive,
} from './soap-client.ts'
import { type SonosPersistedPlayer } from './types.ts'

type CapturedRequest = {
	url: string
	action: string
	body: string
}

function installSoapFetchMock() {
	const requests: Array<CapturedRequest> = []
	vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers)
		const action = headers.get('SOAPAction') ?? ''
		const body = String(init?.body ?? '')
		requests.push({
			url,
			action,
			body,
		})
		if (action.endsWith('#AddURIToQueue')) {
			return new Response(
				'<?xml version="1.0"?><s:Envelope><s:Body><u:AddURIToQueueResponse><FirstTrackNumberEnqueued>4</FirstTrackNumberEnqueued><NumTracksAdded>2</NumTracksAdded><NewQueueLength>5</NewQueueLength></u:AddURIToQueueResponse></s:Body></s:Envelope>',
			)
		}
		if (action.endsWith('#CreateObject')) {
			return new Response(
				'<?xml version="1.0"?><s:Envelope><s:Body><u:CreateObjectResponse><ObjectID>FV:2/99</ObjectID></u:CreateObjectResponse></s:Body></s:Envelope>',
			)
		}
		return new Response(
			'<?xml version="1.0"?><s:Envelope><s:Body></s:Body></s:Envelope>',
		)
	})
	return requests
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('addSonosUriToQueueLive XML-escapes container URIs and metadata', async () => {
	const requests = installSoapFetchMock()

	const result = await addSonosUriToQueueLive({
		host: 'office-sonos.local',
		uri: 'x-rincon-cpcontainer:1006286cspotify%3Aplaylist%3Aabc123?sid=12&flags=10348&sn=6',
		metadata:
			'<DIDL-Lite><item><dc:title>Rock & Roll</dc:title><desc>SA_RINCON3079_X_#Svc3079-token</desc></item></DIDL-Lite>',
		enqueueAsNext: true,
	})
	const request = requests[0]

	expect(result).toEqual({
		firstTrackNumberEnqueued: 4,
		numTracksAdded: 2,
		newQueueLength: 5,
	})
	expect(request?.action).toBe(
		'urn:schemas-upnp-org:service:AVTransport:1#AddURIToQueue',
	)
	expect(request?.body).toContain(
		'<EnqueuedURI>x-rincon-cpcontainer:1006286cspotify%3Aplaylist%3Aabc123?sid=12&amp;flags=10348&amp;sn=6</EnqueuedURI>',
	)
	expect(request?.body).toContain('<EnqueuedURIMetaData>&lt;DIDL-Lite&gt;')
	expect(request?.body).toContain('Rock &amp; Roll')
	expect(request?.body).toContain('<EnqueueAsNext>1</EnqueueAsNext>')
})

test('createSonosFavoriteLive builds escaped Favorites CreateObject payload', async () => {
	const requests = installSoapFetchMock()

	const favorite = await createSonosFavoriteLive({
		host: 'office-sonos.local',
		title: 'Rock & Roll',
		uri: 'x-sonosapi-radio:station?sid=254&flags=32',
		metadata:
			'<DIDL-Lite><item><dc:title>Rock & Roll Radio</dc:title></item></DIDL-Lite>',
		description: 'Spotify & Sonos',
	})
	const request = requests[0]

	expect(favorite).toEqual({
		favoriteId: 'FV:2/99',
		title: 'Rock & Roll',
		uri: 'x-sonosapi-radio:station?sid=254&flags=32',
	})
	expect(request?.action).toBe(
		'urn:schemas-upnp-org:service:ContentDirectory:1#CreateObject',
	)
	expect(request?.body).toContain('<ContainerID>FV:2</ContainerID>')
	expect(request?.body).toContain('<Elements>&lt;DIDL-Lite')
	expect(request?.body).toContain('Rock &amp;amp; Roll')
	expect(request?.body).toContain(
		'x-sonosapi-radio:station?sid=254&amp;amp;flags=32',
	)
	expect(request?.body).toContain('&lt;r:resMD&gt;&amp;lt;DIDL-Lite')
	expect(request?.body).toContain('Spotify &amp;amp; Sonos')
})

test('Amp HT TV input uses htastream SPDIF and line-in uses rincon-stream', async () => {
	const requests = installSoapFetchMock()
	const player = {
		playerId: 'sonos-rincon-804af2a8db1f01400',
		udn: 'uuid:RINCON_804AF2A8DB1F01400',
		roomName: 'Sport Court',
		displayName: 'Amp',
		friendlyName: 'Sport Court Sonos Amp',
		modelName: 'Sonos Amp',
		modelNumber: 'S16',
		serialNum: '80-4A-F2-A8-DB-1F:0',
		householdId: 'Sonos_Household',
		host: '192.168.1.111',
		descriptionUrl: 'http://192.168.1.111:1400/xml/device_description.xml',
		audioInputSupported: true,
		adopted: true,
		lastSeenAt: '2026-09-12T00:00:00.000Z',
		rawDescriptionXml: null,
	} satisfies SonosPersistedPlayer

	await selectSonosAudioInputLive({
		host: player.host,
		player,
	})
	await selectSonosTvInputLive({
		host: player.host,
		player,
	})

	const lineInSetUri = requests[0]
	const tvSetUri = requests[2]
	expect(requests.map((request) => request.action)).toEqual([
		'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
		'urn:schemas-upnp-org:service:AVTransport:1#Play',
		'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
		'urn:schemas-upnp-org:service:AVTransport:1#Play',
	])
	expect(lineInSetUri?.body).toContain(
		'<CurrentURI>x-rincon-stream:RINCON_804AF2A8DB1F01400</CurrentURI>',
	)
	expect(tvSetUri?.body).toContain(
		'<CurrentURI>x-sonos-htastream:RINCON_804AF2A8DB1F01400:spdif</CurrentURI>',
	)
	expect(tvSetUri?.body).not.toContain('x-sonos-ht:spdif')
	expect(tvSetUri?.body).not.toContain('x-sonos-ht:hdmi')
	expect(tvSetUri?.body).not.toContain('x-rincon-stream:')
})

test('TV input UPnP 714 fails clearly and does not select line-in', async () => {
	vi.stubGlobal('fetch', async () => {
		return new Response(
			'<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>714</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
			{ status: 500 },
		)
	})
	const player = {
		playerId: 'sonos-rincon-804af2a8db1f01400',
		udn: 'uuid:RINCON_804AF2A8DB1F01400',
		roomName: 'Sport Court',
		displayName: 'Amp',
		friendlyName: 'Sport Court Sonos Amp',
		modelName: 'Sonos Amp',
		modelNumber: 'S16',
		serialNum: '80-4A-F2-A8-DB-1F:0',
		householdId: 'Sonos_Household',
		host: '192.168.1.111',
		descriptionUrl: 'http://192.168.1.111:1400/xml/device_description.xml',
		audioInputSupported: true,
		adopted: true,
		lastSeenAt: '2026-09-12T00:00:00.000Z',
		rawDescriptionXml: null,
	} satisfies SonosPersistedPlayer

	const error = await selectSonosTvInputLive({
		host: player.host,
		player,
	}).catch((caught: unknown) => caught)

	expect(error).toMatchObject({
		name: 'SonosTvInputUnavailableError',
		message: expect.stringContaining(
			'x-sonos-htastream:RINCON_804AF2A8DB1F01400:spdif',
		),
	})
	expect((error as Error).message).toContain('line-in was not selected')
	expect((error as Error).message).not.toMatch(
		/selected the sonos audio input/i,
	)
})

test('queue playback helpers target the Sonos queue and TRACK_NR seek unit', async () => {
	const requests = installSoapFetchMock()

	await setSonosTransportUriLive({
		host: 'office-sonos.local',
		uri: 'x-rincon-queue:RINCON_MOCK_OFFICE_01400#0',
	})
	await seekSonosQueueTrackLive('office-sonos.local', 4)
	await playSonosLive('office-sonos.local')

	expect(requests.map((request) => request.action)).toEqual([
		'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
		'urn:schemas-upnp-org:service:AVTransport:1#Seek',
		'urn:schemas-upnp-org:service:AVTransport:1#Play',
	])
	expect(requests[1]?.body).toContain('<Unit>TRACK_NR</Unit>')
	expect(requests[1]?.body).toContain('<Target>4</Target>')
})

test('removeSonosQueueTrackRangeLive removes a 1-based queue range', async () => {
	const requests = installSoapFetchMock()

	await removeSonosQueueTrackRangeLive({
		host: 'office-sonos.local',
		startingIndex: 2,
		numberOfTracks: 3,
	})

	expect(requests[0]?.action).toBe(
		'urn:schemas-upnp-org:service:AVTransport:1#RemoveTrackRangeFromQueue',
	)
	expect(requests[0]?.body).toContain('<StartingIndex>2</StartingIndex>')
	expect(requests[0]?.body).toContain('<NumberOfTracks>3</NumberOfTracks>')
})

test('setSonosVolumeLive marks UPnP 501 Action Failed as expected noise', async () => {
	let callCount = 0
	vi.stubGlobal('fetch', async () => {
		callCount += 1
		return new Response(
			'<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>501</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
			{ status: 500 },
		)
	})

	const error = await setSonosVolumeLive('192.168.0.158', 12).catch(
		(caught: unknown) => caught,
	)

	expect(callCount).toBe(1)
	expect(error).toMatchObject({
		name: 'SonosSoapError',
		homeConnectorCaptureContext: {
			shouldCapture: false,
			tags: {
				connector_vendor: 'sonos',
				sonos_soap_action: 'SetVolume',
				sonos_failure_cause_class: 'http_error',
				sonos_http_status: '500',
				sonos_upnp_error: '501',
			},
		},
	})
})

test('sonos soap timeouts retry once and annotate dedupe metadata', async () => {
	let callCount = 0
	vi.stubGlobal('fetch', async () => {
		callCount += 1
		throw new DOMException('The operation timed out.', 'TimeoutError')
	})

	const error = await playSonosLive('192.168.1.115').catch(
		(caught: unknown) => caught,
	)

	expect(callCount).toBe(2)
	expect(error).toMatchObject({
		name: 'SonosSoapError',
		message: expect.stringContaining('timed out after 10000ms'),
		homeConnectorCaptureContext: {
			tags: {
				connector_vendor: 'sonos',
				sonos_soap_action: 'Play',
				sonos_failure_cause_class: 'timeout',
			},
			dedupe: {
				ttlMs: 60 * 60 * 1000,
			},
		},
	})
})
