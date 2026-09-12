import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { AudiobookError } from './types.ts'

const m4bSuffix = '.m4b'

export function sanitizeAudiobookFilename(rawFilename: string) {
	const trimmed = rawFilename.trim()
	if (trimmed.length === 0) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message: 'outputFilename is required.',
			filename: rawFilename,
		})
	}
	if (
		trimmed.includes('\u0000') ||
		trimmed.includes('\r') ||
		trimmed.includes('\n')
	) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message: 'outputFilename must not contain control characters.',
			filename: rawFilename,
		})
	}
	if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message:
				'outputFilename must be a flat Title.m4b name, not a hidden path.',
			filename: rawFilename,
		})
	}
	if (trimmed.includes('/') || trimmed.includes('\\')) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message:
				'outputFilename must be a flat file in the audiobook library root. Subdirectories and ".." are rejected.',
			filename: rawFilename,
		})
	}
	if (path.basename(trimmed) !== trimmed) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message: 'outputFilename must not include a directory path.',
			filename: rawFilename,
		})
	}

	const filename = trimmed.toLowerCase().endsWith(m4bSuffix)
		? trimmed
		: `${trimmed}${m4bSuffix}`
	if (filename === m4bSuffix) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message: 'outputFilename must include a title before .m4b.',
			filename: rawFilename,
		})
	}
	return filename
}

export function resolvePathInsideLibrary(
	libraryRoot: string,
	filename: string,
) {
	const resolvedLibrary = path.resolve(libraryRoot)
	const resolvedPath = path.resolve(resolvedLibrary, filename)
	const relative = path.relative(resolvedLibrary, resolvedPath)
	if (
		relative.length === 0 ||
		relative.startsWith('..') ||
		path.isAbsolute(relative) ||
		relative.split(/[\\/]/).length !== 1
	) {
		throw new AudiobookError({
			code: 'audiobook_path_invalid',
			message: `Refusing path ${filename} because it escapes the audiobook library root.`,
			filename,
			path: resolvedPath,
		})
	}
	return {
		libraryRoot: resolvedLibrary,
		filename,
		path: resolvedPath,
	}
}

export async function resolveLibraryRoot(libraryPath: string) {
	const resolved = path.resolve(libraryPath)
	try {
		const stats = await stat(resolved)
		if (!stats.isDirectory()) {
			throw new AudiobookError({
				code: 'audiobook_library_unavailable',
				message: `Audiobook library path is not a directory: ${resolved}`,
				path: resolved,
			})
		}
		return await realpath(resolved)
	} catch (error) {
		if (error instanceof AudiobookError) throw error
		throw new AudiobookError({
			code: 'audiobook_library_unavailable',
			message: `Audiobook library is not mounted or not readable: ${resolved}`,
			path: resolved,
		})
	}
}

export async function isWritableDirectory(directory: string) {
	try {
		await access(directory, fsConstants.W_OK)
		return true
	} catch {
		return false
	}
}

export async function pathExists(targetPath: string) {
	try {
		await stat(targetPath)
		return true
	} catch {
		return false
	}
}

export function resolveSafeLibraryFile(
	libraryRoot: string,
	rawFilename: string,
) {
	const filename = sanitizeAudiobookFilename(rawFilename)
	return resolvePathInsideLibrary(libraryRoot, filename)
}
