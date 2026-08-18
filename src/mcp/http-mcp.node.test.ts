import { expect, test } from 'vitest'
import { createHomeMcpHttpHandler, serveHomeMcpRequest } from './http-mcp.ts'
import { type HomeConnectorToolRegistry } from './server.ts'
import { type AuthInfo } from '@modelcontextprotocol/server'

function createRegistry(): HomeConnectorToolRegistry {
	return {
		list() {
			return [
				{
					name: 'ping',
					title: 'Ping',
					description: 'Return pong.',
					inputSchema: { type: 'object', properties: {} },
				},
			]
		},
		listHttp() {
			return [
				{
					name: 'ping',
					title: 'Ping',
					description: 'Return pong.',
					inputSchema: { type: 'object', properties: {} },
				},
			]
		},
		async call() {
			return {
				content: [{ type: 'text', text: 'pong' }],
			}
		},
	}
}

test('authorized Streamable HTTP initialize reaches the tool server', async () => {
	const handler = createHomeMcpHttpHandler({
		toolRegistry: createRegistry(),
		instructions: 'test home mcp',
	})
	const authInfo = {
		token: 'test-token',
		clientId: 'https://kody.codes/oauth/client-metadata.json',
		scopes: ['mcp'],
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
		resource: new URL('https://kody-home.doddsfamily.us/mcp'),
	} satisfies AuthInfo
	const response = await serveHomeMcpRequest({
		request: new Request('https://kody-home.doddsfamily.us/mcp', {
			method: 'POST',
			headers: {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2025-03-26',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-03-26',
					capabilities: {},
					clientInfo: { name: 'test', version: '0.0.0' },
				},
			}),
		}),
		handler,
		authInfo,
	})
	expect(response.status).toBeLessThan(500)
	const text = await response.text()
	expect(text).toContain('kody-home-connector')
})
