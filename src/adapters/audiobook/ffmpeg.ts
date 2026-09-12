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

export function escapeFfmetadataValue(value: string) {
	return value.replace(/[\\=;#\n]/g, (character) => `\\${character}`)
}

export type AudiobookChapterInput = {
	title: string
	startMs?: number
	start_offset_ms?: number
	endMs?: number
	lengthMs?: number
	length_ms?: number
}

export function buildFfmetadata(input: {
	title?: string
	chapters?: Array<AudiobookChapterInput>
}) {
	const lines = [';FFMETADATA1']
	if (input.title?.trim()) {
		lines.push(`title=${escapeFfmetadataValue(input.title.trim())}`)
	}
	const chapters = input.chapters ?? []
	for (const [index, chapter] of chapters.entries()) {
		const start =
			chapter.startMs ?? chapter.start_offset_ms ?? (index === 0 ? 0 : null)
		if (start == null || !Number.isFinite(start) || start < 0) {
			continue
		}
		const length = chapter.lengthMs ?? chapter.length_ms
		const explicitEnd = chapter.endMs
		const nextStart =
			chapters[index + 1]?.startMs ?? chapters[index + 1]?.start_offset_ms
		const end =
			explicitEnd ?? (length != null ? start + length : nextStart) ?? start
		lines.push('[CHAPTER]')
		lines.push('TIMEBASE=1/1000')
		lines.push(`START=${Math.trunc(start)}`)
		lines.push(`END=${Math.max(Math.trunc(end), Math.trunc(start))}`)
		if (chapter.title.trim()) {
			lines.push(`title=${escapeFfmetadataValue(chapter.title.trim())}`)
		}
	}
	return `${lines.join('\n')}\n`
}

export function buildFfmpegConvertArgs(input: {
	credentials: AudiobookDecryptCredentials
	sourcePath: string
	outputPath: string
	metadataPath?: string
	coverPath?: string
}): Array<string> {
	const args = [
		'-hide_banner',
		'-y',
		...buildFfmpegDecryptArgs(input.credentials),
		'-i',
		input.sourcePath,
	]
	if (input.metadataPath) {
		args.push('-i', input.metadataPath)
	}
	if (input.coverPath) {
		args.push('-i', input.coverPath)
	}
	if (input.metadataPath || input.coverPath) {
		args.push('-map', '0:a?')
		if (input.metadataPath) {
			args.push('-map_metadata', '1')
		}
		if (input.coverPath) {
			args.push(
				'-map',
				input.metadataPath ? '2' : '1',
				'-disposition:v:0',
				'attached_pic',
			)
		}
	}
	args.push('-c', 'copy', input.outputPath)
	return args
}
