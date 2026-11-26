import { http, HttpResponse } from 'msw'

const rokuDevices = [
	{
		id: 'roku-living-room',
		name: 'Living Room Roku',
		location: 'http://192.168.1.45:8060/',
		lastSeenAt: '2026-03-24T12:00:00.000Z',
		adopted: true,
		controlEnabled: true,
	},
	{
		id: 'roku-court-projector',
		name: 'Court Projector',
		location: 'http://192.168.1.98:8060/',
		lastSeenAt: '2026-03-24T12:00:00.000Z',
		adopted: true,
		controlEnabled: true,
	},
	{
		id: 'roku-bedroom',
		name: 'Bedroom Roku',
		location: 'http://192.168.1.46:8060/',
		lastSeenAt: '2026-03-24T12:00:00.000Z',
		adopted: false,
		controlEnabled: false,
	},
] as const

const mockRokuApps = [
	{ id: '837', type: 'appl', version: '5.7.0', name: 'YouTube' },
	{ id: '13842', type: 'appl', version: '2.0.1', name: 'Jellyfin' },
] as const

type MockRokuPlayback = {
	appId: string
	playerState: 'play' | 'close'
	contentId: string | null
}

const mockRokuPlayback = new Map<string, MockRokuPlayback>()

function getMockRokuPlayback(baseUrl: string): MockRokuPlayback {
	return (
		mockRokuPlayback.get(baseUrl) ?? {
			appId: '13842',
			playerState: 'close',
			contentId: null,
		}
	)
}

export function resetMockRokuState() {
	mockRokuPlayback.clear()
}

function renderMockRokuApp(appId: string) {
	const app = mockRokuApps.find((entry) => entry.id === appId)
	return app
		? `<app id="${app.id}" type="${app.type}" version="${app.version}">${app.name}</app>`
		: `<app>Roku</app>`
}

export function createRokuEcpHandlers(location: string) {
	const baseUrl = location.replace(/\/$/, '')
	return [
		http.get(`${baseUrl}/query/apps`, () => {
			return HttpResponse.xml(
				`<?xml version="1.0" encoding="UTF-8"?>
<apps>
${mockRokuApps.map((app) => `\t${renderMockRokuApp(app.id)}`).join('\n')}
</apps>`,
				{ status: 200 },
			)
		}),
		http.get(`${baseUrl}/query/active-app`, () => {
			const playback = getMockRokuPlayback(baseUrl)
			return HttpResponse.xml(
				`<?xml version="1.0" encoding="UTF-8"?>
<active-app>
	${renderMockRokuApp(playback.appId)}
</active-app>`,
				{ status: 200 },
			)
		}),
		http.get(`${baseUrl}/query/media-player`, () => {
			const playback = getMockRokuPlayback(baseUrl)
			const app = mockRokuApps.find((entry) => entry.id === playback.appId)
			if (playback.playerState === 'close' || !app) {
				return HttpResponse.xml(
					`<?xml version="1.0" encoding="UTF-8"?>
<player error="false" state="close" />`,
					{ status: 200 },
				)
			}
			return HttpResponse.xml(
				`<?xml version="1.0" encoding="UTF-8"?>
<player error="false" state="${playback.playerState}">
	<plugin bandwidth="25000000 bps" id="${app.id}" name="${app.name}"/>
	<format audio="aac_adts" captions="none" drm="none" video="mpeg4_10b"/>
	<buffering current="1000" max="1000" target="0"/>
	<position>12345 ms</position>
	<duration>212000 ms</duration>
	<is_live blocked="false">false</is_live>
	<runtime>212000 ms</runtime>
	<stream_segment bitrate="0" media_sequence="0" segment_type="mux" time="0"/>
</player>`,
				{ status: 200 },
			)
		}),
		http.post(
			`${baseUrl}/keypress/:key`,
			() => new HttpResponse(null, { status: 200 }),
		),
		http.post(`${baseUrl}/launch/:appId`, ({ params, request }) => {
			const contentId =
				new URL(request.url).searchParams.get('contentId') ?? null
			mockRokuPlayback.set(baseUrl, {
				appId: String(params['appId']),
				playerState: contentId ? 'play' : 'close',
				contentId,
			})
			return new HttpResponse(null, { status: 200 })
		}),
	]
}

export const rokuHandlers = [
	http.get('http://roku.mock.local/discovery', () => {
		return HttpResponse.json({
			devices: rokuDevices,
		})
	}),
	...rokuDevices.flatMap((device) => createRokuEcpHandlers(device.location)),
]
