import { loadHomeConnectorConfig } from '../../config.ts'
import { createNasContainerAdapter } from './index.ts'
import {
	readNasContainerOperation,
	writeNasContainerOperation,
} from './operation-status.ts'

/**
 * Detached self-update helper. Started as a one-shot container from the new
 * home-connector image with NAS_CONTAINER_UPDATE_HELPER=1. Performs rename →
 * recreate → health → rollback/cleanup and writes status under the data volume.
 */
export async function runNasContainerUpdateHelper(): Promise<number> {
	const operationId = process.env.NAS_CONTAINER_UPDATE_OPERATION_ID?.trim()
	if (!operationId) {
		console.error(
			'NAS_CONTAINER_UPDATE_OPERATION_ID is required for the update helper.',
		)
		return 1
	}

	const config = loadHomeConnectorConfig()
	const adapter = createNasContainerAdapter({ config })
	try {
		const result = await adapter.runHelperOperation(operationId)
		if (result.status === 'updated') {
			console.log(
				JSON.stringify({
					ok: true,
					status: 'succeeded',
					operationId,
					newImageId: result.newImageId,
					newDigest: result.newDigest,
					newCommit: result.newCommit,
				}),
			)
			return 0
		}
		console.error(
			JSON.stringify({
				ok: false,
				status: 'rolled_back',
				operationId,
				error: result.error,
			}),
		)
		return 2
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const existing = await readNasContainerOperation(
			config.dataPath,
			operationId,
		)
		if (existing) {
			await writeNasContainerOperation(config.dataPath, {
				...existing,
				status: 'failed',
				error: message,
			})
		}
		console.error(
			JSON.stringify({
				ok: false,
				status: 'failed',
				operationId,
				error: message,
			}),
		)
		return 1
	}
}
