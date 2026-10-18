import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	buildToolInputSchema,
	type SdkToolInputSchema,
} from '../mcp/tool-input-schema.ts'
import {
	listRuntimeSettingDefinitions,
	runtimeIntegrationToolPrefixes,
	type RuntimeIntegrationId,
} from './definitions.ts'
import { type RuntimeConfigService } from './service.ts'

type RuntimeConfigToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type RuntimeConfigRegisteredToolDescriptor = RuntimeConfigToolDescriptor & {
	sdkInputSchema?: SdkToolInputSchema
}

type RuntimeConfigToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

function structuredTextResult(
	text: string,
	structuredContent: Record<string, unknown>,
): CallToolResult {
	return {
		content: [
			{
				type: 'text',
				text,
			},
		],
		structuredContent,
	}
}

function structuredErrorResult(message: string): CallToolResult {
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: message,
			},
		],
		structuredContent: {
			error: {
				code: 'invalid_runtime_config',
				message,
			},
		},
	}
}

function titleCaseIntegration(integration: RuntimeIntegrationId) {
	return integration
		.split('_')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')
}

function buildSetConfigSchema(integration: RuntimeIntegrationId) {
	const definitions = listRuntimeSettingDefinitions(integration)
	const shape: Record<string, z.ZodType> = {}
	for (const definition of definitions) {
		const description = `${definition.description} (env: ${definition.envVar})`
		switch (definition.kind) {
			case 'boolean':
				shape[definition.field] = z.boolean().optional().describe(description)
				break
			case 'integer':
				shape[definition.field] = z
					.number()
					.int()
					.optional()
					.describe(description)
				break
			case 'string_list':
				shape[definition.field] = z
					.array(z.string().min(1))
					.optional()
					.describe(description)
				break
			case 'url':
			case 'string':
				shape[definition.field] = z
					.string()
					.nullable()
					.optional()
					.describe(description)
				break
			default: {
				const _exhaustive: never = definition.kind
				throw new Error(`Unhandled kind ${String(_exhaustive)}`)
			}
		}
	}
	return buildToolInputSchema(shape)
}

function buildClearConfigSchema(integration: RuntimeIntegrationId) {
	const fields = listRuntimeSettingDefinitions(integration).map(
		(definition) => definition.field,
	)
	return buildToolInputSchema({
		fields: z
			.array(z.enum(fields as [string, ...Array<string>]))
			.optional()
			.describe(
				`Optional subset of fields to clear. Omit to clear all ${integration} runtime settings and fall back to env/defaults.`,
			),
	})
}

export function registerRuntimeConfigHomeConnectorTools(input: {
	registerTool: (
		descriptor: RuntimeConfigRegisteredToolDescriptor,
		handler: RuntimeConfigToolHandler,
	) => void
	runtimeConfig: RuntimeConfigService
	integrations?: Array<RuntimeIntegrationId>
}) {
	const integrations =
		input.integrations ??
		(Object.keys(runtimeIntegrationToolPrefixes) as Array<RuntimeIntegrationId>)

	for (const integration of integrations) {
		const prefix = runtimeIntegrationToolPrefixes[integration]
		const label = titleCaseIntegration(integration)
		const fields = listRuntimeSettingDefinitions(integration)
			.map((definition) => definition.field)
			.join(', ')

		input.registerTool(
			{
				name: `${prefix}_get_config`,
				title: `Get ${label} Runtime Config`,
				description: `Read non-secret runtime configuration for ${integration}. Reports each field's effective value and source (stored | env | default). Precedence: stored > env > default. Secrets are never returned. Fields: ${fields}.`,
				inputSchema: {},
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
				},
			},
			async () => {
				const snapshot =
					await input.runtimeConfig.getIntegrationConfig(integration)
				return structuredTextResult(
					`${label} runtime config (${String(snapshot.settings.length)} fields). ${snapshot.precedence}`,
					snapshot,
				)
			},
		)

		const setSchema = buildSetConfigSchema(integration)
		input.registerTool(
			{
				name: `${prefix}_set_config`,
				title: `Set ${label} Runtime Config`,
				description: `Persist one or more ${integration} settings in local SQLite under HOST_DATA_PATH and apply them immediately (no container restart). Stored values override env until cleared. Validates inputs. Never use this for credentials — use the integration's set_credentials / setup page. Fields: ${fields}.`,
				inputSchema: setSchema.inputSchema,
				sdkInputSchema: setSchema.sdkInputSchema,
			},
			async (args) => {
				try {
					const result = await input.runtimeConfig.setIntegrationConfig(
						integration,
						args,
					)
					return structuredTextResult(
						`Updated ${label} runtime config fields: ${result.updatedFields.join(', ') || '(none)'}.`,
						result,
					)
				} catch (error) {
					return structuredErrorResult(
						error instanceof Error ? error.message : String(error),
					)
				}
			},
		)

		const clearSchema = buildClearConfigSchema(integration)
		input.registerTool(
			{
				name: `${prefix}_clear_config`,
				title: `Clear ${label} Runtime Config`,
				description: `Delete stored ${integration} runtime settings so env vars / built-in defaults apply again. Optional fields array clears a subset.`,
				inputSchema: clearSchema.inputSchema,
				sdkInputSchema: clearSchema.sdkInputSchema,
			},
			async (args) => {
				try {
					const fieldsArg = args['fields']
					const fields = Array.isArray(fieldsArg)
						? fieldsArg.map((entry) => String(entry))
						: undefined
					const result = await input.runtimeConfig.clearIntegrationConfig(
						integration,
						fields,
					)
					return structuredTextResult(
						`Cleared ${label} runtime config fields: ${result.clearedFields.join(', ')}.`,
						result,
					)
				} catch (error) {
					return structuredErrorResult(
						error instanceof Error ? error.message : String(error),
					)
				}
			},
		)
	}
}
