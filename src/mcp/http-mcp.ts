import {
	McpServer,
	createMcpHandler,
	type AuthInfo,
} from '@modelcontextprotocol/server'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { z } from 'zod'
import { type HomeConnectorToolRegistry } from './server.ts'

const homeMcpServerInfo = {
	name: 'kody-home-connector',
	version: '1.0.0',
} as const

export const homeMcpHttpInstructions =
	'Home MCP server for local-network devices, including an Android phone companion over WebSocket at /phone/ws. Tools stay on this process; Kody connects over Streamable HTTP at /mcp after CIMD OAuth. Phone tools are kody.mcp["home"].phone_*.'

export function createHomeMcpHttpHandler(input: {
	toolRegistry: HomeConnectorToolRegistry
	instructions: string
}) {
	return createMcpHandler(
		() => {
			const server = new McpServer(homeMcpServerInfo, {
				instructions: input.instructions,
				jsonSchemaValidator: new AjvJsonSchemaValidator(),
			})
			for (const tool of input.toolRegistry.listHttp()) {
				server.registerTool(
					tool.name,
					{
						title: tool.title,
						description: tool.description,
						inputSchema: tool.sdkInputSchema ?? z.object({}),
						...(tool.sdkOutputSchema
							? { outputSchema: tool.sdkOutputSchema }
							: {}),
						...(tool.annotations ? { annotations: tool.annotations } : {}),
					},
					async (args) =>
						input.toolRegistry.call(
							tool.name,
							(args ?? {}) as Record<string, unknown>,
							{
								transport: 'http',
								source: 'mcp-http',
							},
						),
				)
			}
			return server
		},
		{
			onerror: (error) => {
				console.warn('home-mcp-http-error', error)
			},
		},
	)
}

export async function serveHomeMcpRequest(input: {
	request: Request
	handler: ReturnType<typeof createHomeMcpHttpHandler>
	authInfo: AuthInfo
}) {
	return input.handler.fetch(input.request, { authInfo: input.authInfo })
}
