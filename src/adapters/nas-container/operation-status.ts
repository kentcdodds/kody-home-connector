import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { type NasContainerUpdateOperation } from './types.ts'

export function nasContainerOperationsDir(dataPath: string) {
	return path.join(dataPath, 'nas-container-updates')
}

export function nasContainerOperationPath(
	dataPath: string,
	operationId: string,
) {
	if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) {
		throw new Error('Invalid operationId.')
	}
	return path.join(nasContainerOperationsDir(dataPath), `${operationId}.json`)
}

export function createNasContainerOperationId() {
	return randomUUID().replaceAll('-', '')
}

export async function writeNasContainerOperation(
	dataPath: string,
	operation: NasContainerUpdateOperation,
): Promise<NasContainerUpdateOperation> {
	const dir = nasContainerOperationsDir(dataPath)
	await mkdir(dir, { recursive: true })
	const updated: NasContainerUpdateOperation = {
		...operation,
		updatedAt: new Date().toISOString(),
	}
	await writeFile(
		nasContainerOperationPath(dataPath, operation.operationId),
		`${JSON.stringify(updated, null, 2)}\n`,
		'utf8',
	)
	return updated
}

export async function readNasContainerOperation(
	dataPath: string,
	operationId: string,
): Promise<NasContainerUpdateOperation | null> {
	try {
		const raw = await readFile(
			nasContainerOperationPath(dataPath, operationId),
			'utf8',
		)
		return JSON.parse(raw) as NasContainerUpdateOperation
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			(error as { code?: string }).code === 'ENOENT'
		) {
			return null
		}
		throw error
	}
}

export async function listNasContainerOperations(
	dataPath: string,
): Promise<Array<NasContainerUpdateOperation>> {
	const dir = nasContainerOperationsDir(dataPath)
	let entries: Array<string>
	try {
		entries = await readdir(dir)
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			(error as { code?: string }).code === 'ENOENT'
		) {
			return []
		}
		throw error
	}
	const operations: Array<NasContainerUpdateOperation> = []
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue
		const operationId = entry.slice(0, -'.json'.length)
		const operation = await readNasContainerOperation(dataPath, operationId)
		if (operation) operations.push(operation)
	}
	operations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	return operations
}
