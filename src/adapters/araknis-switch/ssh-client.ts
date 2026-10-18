import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type HomeConnectorConfig } from '../../config.ts'
import { parseLldpRemoteDeviceCli } from './parsing.ts'
import {
	type AraknisSwitchCredentials,
	type AraknisSwitchLldpNeighbor,
} from './types.ts'
import {
	assertAraknisSwitchCredentialsPresent,
	resolveAraknisSwitchBaseUrl,
	resolveAraknisSwitchHost,
} from './validation.ts'

type LocalCommandResult = {
	stdout: string
	stderr: string
	exitCode: number | null
	timedOut: boolean
}

function onceProcessExit(child: ChildProcess) {
	return new Promise<{
		exitCode: number | null
		signal: NodeJS.Signals | null
	}>((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (exitCode, signal) => {
			resolve({ exitCode, signal })
		})
	})
}

async function runLocalCommand(input: {
	command: string
	args: Array<string>
	env?: NodeJS.ProcessEnv
	timeoutMs: number
	/** Optional stdin to drive interactive CLIs (for example FASTPATH SSH). */
	stdinText?: string
}) {
	const child = spawn(input.command, input.args, {
		stdio: 'pipe',
		env: input.env,
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
	if (input.stdinText != null) {
		child.stdin?.write(input.stdinText)
	}
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
			if (!closed) child.kill('SIGKILL')
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
		timedOut,
	} satisfies LocalCommandResult
}

const allowedShowCommands = new Set([
	'show lldp remote-device',
	'show power inline',
	'show poe',
])

/**
 * Read-only SSH helper for FASTPATH CLI when OpEN lacks a resource.
 * Uses OpenSSH + a temporary askpass script so the password never appears on
 * argv. The askpass file is mode 0700 and deleted in finally.
 *
 * Only allowlisted `show …` commands are accepted — never arbitrary CLI.
 */
export async function fetchAraknisShowCommandOverSsh(input: {
	config: HomeConnectorConfig
	credentials: AraknisSwitchCredentials
	command: string
}): Promise<string> {
	const command = input.command.trim().replace(/\s+/g, ' ')
	if (!allowedShowCommands.has(command)) {
		throw new Error(
			`Araknis switch SSH helper refused command "${command}". Only allowlisted read-only show commands are permitted.`,
		)
	}
	const credentials = assertAraknisSwitchCredentialsPresent(input.credentials)
	const config = input.config
	const host =
		resolveAraknisSwitchHost(resolveAraknisSwitchBaseUrl(config)) ??
		'192.168.0.50'
	const username = credentials.username
	const password = credentials.password
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-araknis-ssh-'))
	const askPassPath = path.join(tempDir, 'askpass.sh')

	try {
		// Password is written only to a 0700 temp script; never logged.
		await writeFile(
			askPassPath,
			`#!/bin/sh\nprintf '%s\\n' "$ARAKNIS_SWITCH_SSH_ASKPASS_PASSWORD"\n`,
			{ mode: 0o700 },
		)
		await chmod(askPassPath, 0o700)

		// Araknis/FASTPATH SSH is an interactive CLI, not a remote command
		// executor. Force a PTY and drive the show command over stdin.
		const result = await runLocalCommand({
			command: 'ssh',
			args: [
				'-tt',
				'-p',
				String(config.araknisSwitchSshPort),
				'-o',
				'BatchMode=no',
				'-o',
				'StrictHostKeyChecking=accept-new',
				'-o',
				'UserKnownHostsFile=/dev/null',
				'-o',
				'GlobalKnownHostsFile=/dev/null',
				'-o',
				'PreferredAuthentications=password',
				'-o',
				'PubkeyAuthentication=no',
				'-o',
				'NumberOfPasswordPrompts=1',
				'-o',
				'LogLevel=ERROR',
				`${username}@${host}`,
			],
			stdinText: `terminal length 0\n${command}\nexit\n`,
			env: {
				...process.env,
				DISPLAY: process.env.DISPLAY || ':0',
				SSH_ASKPASS: askPassPath,
				SSH_ASKPASS_REQUIRE: 'force',
				ARAKNIS_SWITCH_SSH_ASKPASS_PASSWORD: password,
			},
			timeoutMs: config.araknisSwitchRequestTimeoutMs,
		})

		if (result.timedOut) {
			throw new Error(
				`Araknis switch SSH command timed out after ${config.araknisSwitchRequestTimeoutMs}ms.`,
			)
		}
		if (result.exitCode !== 0) {
			throw new Error(
				`Araknis switch SSH command failed with exit code ${String(result.exitCode)}.`,
			)
		}
		return result.stdout
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	}
}

export async function fetchAraknisLldpNeighborsOverSsh(input: {
	config: HomeConnectorConfig
	credentials: AraknisSwitchCredentials
}): Promise<Array<AraknisSwitchLldpNeighbor>> {
	const stdout = await fetchAraknisShowCommandOverSsh({
		...input,
		command: 'show lldp remote-device',
	})
	return parseLldpRemoteDeviceCli(stdout)
}
