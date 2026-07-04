import { afterEach, expect, test, vi } from 'vitest'
import {
	addSonosUriToQueueLive,
	createSonosFavoriteLive,
	playSonosLive,
	seekSonosQueueTrackLive,
	setSonosTransportUriLive,
} from './soap-client.ts'

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
