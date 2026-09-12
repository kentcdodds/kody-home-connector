import { spawn, type ChildProcess } from 'node:child_process'
import { type AudiobookDecryptCredentials, type FfmpegRunner } from './types.ts'

function onceProcessExit(child: ChildProcess) {
	return new Promise<{
		exitCode: number | null
		signal: NodeJS.Signals | null
	}>((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (exitCode, signal) => {
			resolve({
				exitCode,
				signal,
			})
		})
	})
}

export const runFfmpegCommand: FfmpegRunner = async (input) => {
	const child = spawn(input.command, input.args, {
		stdio: 'pipe',
	})
	let stdout = ''
	let stderr = ''
	child.stdout?.setEncoding('utf8')
	child.stdout?.on('data', (chunk: string | Buffer) => {
		stdout += String(chunk)
	})
	child.stderr?.setEncoding('utf8')
	child.stderr?.on('data', (chunk: string | Buffer) => {
		stderr += String(chunk)
	})
	child.stdin?.end()

	let timedOut = false
	let closed = false
	child.once('close', () => {
		closed = true
	})
	const timeout = setTimeout(() => {
		timedOut = true
		child.kill('SIGTERM')
		setTimeout(() => {
			if (!closed) {
				child.kill('SIGKILL')
			}
		}, 1000).unref()
	}, input.timeoutMs)

	let result: Awaited<ReturnType<typeof onceProcessExit>>
	try {
		result = await onceProcessExit(child)
	} finally {
		clearTimeout(timeout)
	}

	return {
		stdout,
		stderr,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut,
	}
}

export function buildFfmpegDecryptArgs(
	credentials: AudiobookDecryptCredentials,
): Array<string> {
	switch (credentials.kind) {
		case 'aaxc':
			return ['-audible_key', credentials.key, '-audible_iv', credentials.iv]
		case 'aax':
			return ['-activation_bytes', credentials.activationBytes]
		default: {
			const exhaustive: never = credentials
			throw new Error(
				`Unsupported audiobook credentials: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

export function buildFfmpegConvertArgs(input: {
	credentials: AudiobookDecryptCredentials
	sourcePath: string
	outputPath: string
}): Array<string> {
	return [
		'-hide_banner',
		'-y',
		...buildFfmpegDecryptArgs(input.credentials),
		'-i',
		input.sourcePath,
		'-c',
		'copy',
		input.outputPath,
	]
}
