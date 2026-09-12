import { expect, test } from 'vitest'
import { getSonyIrccCode } from './commands.ts'
import {
	buildSonyIrccControlUrlCandidates,
	createSonyIrccHttpClient,
	probeSonyIrccHost,
	sendSonyIrccCommand,
} from './client.ts'
import {
	mockSonyBlurayHost,
	mockSonyDmrXmlAvTransportFirst,
	mockSonyIrccSoapOk,
	mockSonyIrccXml,
} from './fixtures.ts'
import { type SonyIrccHttpClient } from './types.ts'

test('probe matches Ircc.xml and extracts the control URL', async () => {
	const http: SonyIrccHttpClient = async (request) => {
		if (request.url.endsWith('/Ircc.xml')) {
			return { status: 200, headers: {}, body: mockSonyIrccXml }
		}
		throw new Error(`timeout ${request.url}`)
	}
	const probe = await probeSonyIrccHost({
		host: mockSonyBlurayHost,
		http,
		timeoutMs: 250,
	})
	expect(probe.connected).toBe(true)
	expect(probe.model).toBe('UBP-X800M2')
	expect(probe.irccControlUrl).toBe(
		`http://${mockSonyBlurayHost}:50001/upnp/control/IRCC`,
	)
	expect(probe.probedEndpoints.some((endpoint) => endpoint.matched)).toBe(true)
})

test('probe uses the IRCC controlURL when AVTransport is listed first', async () => {
	const http: SonyIrccHttpClient = async (request) => {
		if (request.url.endsWith('/dmr.xml')) {
			return { status: 200, headers: {}, body: mockSonyDmrXmlAvTransportFirst }
		}
		throw new Error(`timeout ${request.url}`)
	}
	const probe = await probeSonyIrccHost({
		host: mockSonyBlurayHost,
		http,
		timeoutMs: 250,
	})
	expect(probe.connected).toBe(true)
	expect(probe.irccControlUrl).toBe(
		`http://${mockSonyBlurayHost}:52323/upnp/control/IRCC`,
	)
	expect(probe.irccControlUrl).not.toMatch(/AVTransport/)
})

test('probe-fail returns matched false without throwing', async () => {
	const http: SonyIrccHttpClient = async (request) => {
		throw new Error(`connect EHOSTUNREACH ${request.url}`)
	}
	const probe = await probeSonyIrccHost({
		host: mockSonyBlurayHost,
		http,
		timeoutMs: 250,
	})
	expect(probe.connected).toBe(false)
	expect(probe.matched).toBe(false)
	expect(probe.probedEndpoints).toHaveLength(3)
	expect(probe.probedEndpoints.every((endpoint) => !endpoint.ok)).toBe(true)
})

test('IRCC send posts the SOAP envelope to the discovered control URL', async () => {
	const urls: Array<string> = []
	const http: SonyIrccHttpClient = async (request) => {
		urls.push(request.url)
		expect(request.method).toBe('POST')
		expect(request.body).toContain(getSonyIrccCode('play'))
		expect(request.headers?.['SOAPACTION']).toBe(
			'"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
		)
		return { status: 200, headers: {}, body: mockSonyIrccSoapOk }
	}
	const sent = await sendSonyIrccCommand({
		host: mockSonyBlurayHost,
		http,
		irccCode: getSonyIrccCode('play'),
		controlUrl: `http://${mockSonyBlurayHost}:50001/upnp/control/IRCC`,
		timeoutMs: 250,
	})
	expect(sent.ok).toBe(true)
	expect(sent.httpStatus).toBe(200)
	expect(urls[0]).toBe(`http://${mockSonyBlurayHost}:50001/upnp/control/IRCC`)
})

test('discovered control URLs on another host are ignored', async () => {
	const crossHost = 'http://169.254.169.254:80/sony/ircc'
	expect(
		buildSonyIrccControlUrlCandidates({
			host: mockSonyBlurayHost,
			discoveredControlUrl: crossHost,
		}),
	).not.toContain(crossHost)

	const urls: Array<string> = []
	const http: SonyIrccHttpClient = async (request) => {
		urls.push(request.url)
		expect(request.headers?.Cookie ?? '').toBe('auth=secret')
		return { status: 200, headers: {}, body: mockSonyIrccSoapOk }
	}
	const sent = await sendSonyIrccCommand({
		host: mockSonyBlurayHost,
		http,
		irccCode: getSonyIrccCode('play'),
		controlUrl: crossHost,
		authCookie: 'secret',
		timeoutMs: 250,
	})
	expect(sent.ok).toBe(true)
	expect(urls).not.toContain(crossHost)
	expect(urls.every((url) => url.includes(mockSonyBlurayHost))).toBe(true)
})

test('Sony IRCC fetch rejects redirects', async () => {
	const calls: Array<{ url: string; redirect?: RequestRedirect }> = []
	const http = createSonyIrccHttpClient(async (url, init) => {
		calls.push({
			url: String(url),
			redirect: init?.redirect,
		})
		return new Response('ok', { status: 200 })
	})
	await http({
		url: `http://${mockSonyBlurayHost}:50001/Ircc.xml`,
		method: 'GET',
		timeoutMs: 250,
	})
	expect(calls[0]?.redirect).toBe('error')
})
