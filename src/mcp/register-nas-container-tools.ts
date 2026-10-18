import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	nasContainerServiceIds,
	nasContainerUpdateConfirmation,
	type createNasContainerAdapter,
} from '../adapters/nas-container/index.ts'
import {
	buildToolInputSchema,
	type SdkToolInputSchema,
} from './tool-input-schema.ts'

type NasContainerToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type NasContainerRegisteredToolDescriptor = NasContainerToolDescriptor & {
	sdkInputSchema?: SdkToolInputSchema
}

type NasContainerToolHandler = (
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
				code: 'nas_container_update_error',
				message,
			},
		},
	}
}

const updateDangerNotice =
	'DISABLED BY DEFAULT: refuses unless Kent enabled nas_container_updates_set_config { enabled: true }. HIGH RISK: pulls the allowlisted main-branch image and recreates the named NAS Docker container (MediaRSS or the home connector itself). Uses the host Docker Engine via the mounted docker.sock. Never accepts branch/PR/dev tags or arbitrary images. Rolls back if /health fails. Self-update hands off to a helper container and returns before this process dies.'

export function registerNasContainerHomeConnectorTools(input: {
	registerTool: (
		descriptor: NasContainerRegisteredToolDescriptor,
		handler: NasContainerToolHandler,
	) => void
	nasContainer: ReturnType<typeof createNasContainerAdapter>
}) {
	const { registerTool, nasContainer } = input

	const serviceSchema = z
		.enum(nasContainerServiceIds)
		.describe(
			'Allowlisted NAS service only: home-connector (kentcdodds/kody-home-connector:latest) or mediarss (kentcdodds/mediarss:main). No other services, tags, digests, or image strings are accepted.',
		)

	const checkSchema = buildToolInputSchema({
		service: serviceSchema,
	})

	registerTool(
		{
			name: 'nas_check_container_update',
			title: 'Check NAS Container Update',
			description:
				'Read-only: compare the running allowlisted NAS container (home-connector or mediarss) to the latest remote digest for its hard-coded main-branch tag. Reports image id, repo digest, created time, running commit when available, remote digest, and updateAvailable. Does not require nas_container_updates.enabled.',
			inputSchema: checkSchema.inputSchema,
			sdkInputSchema: checkSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			try {
				const result = await nasContainer.checkContainerUpdate(args['service'])
				return structuredTextResult(
					result.updateAvailable
						? `Update available for ${result.service} (${result.containerName}): local ${result.repoDigest ?? result.imageId ?? 'unknown'} → remote ${result.remoteDigest ?? 'unknown'}.`
						: `No update available for ${result.service} (${result.containerName}); local digest ${result.repoDigest ?? result.imageId ?? 'unknown'}.`,
					result,
				)
			} catch (error) {
				return structuredErrorResult(
					error instanceof Error ? error.message : String(error),
				)
			}
		},
	)

	const updateSchema = buildToolInputSchema({
		service: serviceSchema,
		dryRun: z
			.boolean()
			.optional()
			.describe(
				'When true: return the exact recreate plan (image, digests, preserved config keys with env values redacted) without pulling or mutating. Works while nas_container_updates.enabled is false.',
			),
		acknowledgeHighRisk: z
			.literal(true)
			.optional()
			.describe('Required unless dryRun=true.'),
		reason: z
			.string()
			.min(20)
			.max(500)
			.optional()
			.describe(
				'Required unless dryRun=true. Operator justification (≥20 chars). Name the service and why you are updating.',
			),
		confirmation: z
			.literal(nasContainerUpdateConfirmation)
			.optional()
			.describe(
				`Required unless dryRun=true. Exact phrase: ${nasContainerUpdateConfirmation}`,
			),
	})

	registerTool(
		{
			name: 'nas_update_container',
			title: 'Update NAS Container',
			description: `${updateDangerNotice}

Pulls the allowlisted main image and recreates the container with the same config (env, binds, network mode, restart policy, ports, labels, name). Never deletes the working container until the replacement passes HTTP /health; on failure rolls back.

For service=home-connector (self-update): returns { status: 'handed_off', operationId } immediately and a helper container finishes the recreate after this process exits. Poll nas_container_update_status.

dryRun=true returns the plan without mutating (works while updates are disabled).`,
			inputSchema: updateSchema.inputSchema,
			sdkInputSchema: updateSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			try {
				const dryRun = args['dryRun'] === true
				const result = await nasContainer.updateContainer({
					service: args['service'],
					dryRun,
					acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
					reason: args['reason'] == null ? undefined : String(args['reason']),
					confirmation:
						args['confirmation'] == null
							? undefined
							: String(args['confirmation']),
				})
				if (result.status === 'dry_run') {
					return structuredTextResult(
						`Dry run plan for ${result.plan.service}: image ${result.plan.imageRef}; updateAvailable=${String(result.plan.updateAvailable)}.`,
						result,
					)
				}
				if (result.status === 'handed_off') {
					return structuredTextResult(
						`Self-update handed off as operation ${result.operationId}. Poll nas_container_update_status.`,
						result,
					)
				}
				if (result.status === 'updated') {
					return structuredTextResult(
						`Updated ${result.service} (${result.containerName}): ${result.oldDigest ?? result.oldImageId ?? 'unknown'} → ${result.newDigest ?? result.newImageId ?? 'unknown'}.`,
						result,
					)
				}
				return structuredTextResult(
					`Update of ${result.service} failed and was rolled back: ${result.error}`,
					result,
				)
			} catch (error) {
				return structuredErrorResult(
					error instanceof Error ? error.message : String(error),
				)
			}
		},
	)

	const statusSchema = buildToolInputSchema({
		operationId: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional operation id from nas_update_container. When omitted, returns the most recent operation(s).',
			),
	})

	registerTool(
		{
			name: 'nas_container_update_status',
			title: 'NAS Container Update Status',
			description:
				'Read the status of a NAS container update operation (including self-update handoff). Status files live on the connector data volume so they survive the home-connector restart.',
			inputSchema: statusSchema.inputSchema,
			sdkInputSchema: statusSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			try {
				const operationId =
					args['operationId'] == null ? null : String(args['operationId'])
				const result = await nasContainer.getUpdateStatus(operationId)
				const current = result.operation
				return structuredTextResult(
					current
						? `NAS container update ${current.operationId}: ${current.status}${current.error ? ` (${current.error})` : ''}.`
						: 'No NAS container update operations found.',
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
