import dgram from 'node:dgram'

export function createWakeOnLanPacket(macAddress: string) {
	const normalized = macAddress.replaceAll(/[^a-fA-F0-9]/g, '')
	if (normalized.length !== 12) {
		throw new Error(
			`Wake-on-LAN requires a 48-bit MAC address. Received "${macAddress}".`,
		)
	}
	const macBytes = Buffer.from(normalized, 'hex')
	return Buffer.concat([
		Buffer.alloc(6, 0xff),
		...Array.from({ length: 16 }, () => macBytes),
	])
}

export function createWakeOnLanTargets(host: string) {
	const targets = new Set<string>(['255.255.255.255'])
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
		const octets = host.split('.')
		targets.add(`${octets[0]}.${octets[1]}.${octets[2]}.255`)
	}
	return [...targets]
}

export async function sendWakeOnLan(input: {
	host: string
	macAddress: string
}) {
	const packet = createWakeOnLanPacket(input.macAddress)
	const socket = dgram.createSocket('udp4')
	try {
		socket.setBroadcast(true)
		const targets = createWakeOnLanTargets(input.host)
		const ports = [9, 7]
		for (const target of targets) {
			for (const port of ports) {
				await new Promise<void>((resolve, reject) => {
					socket.send(packet, port, target, (error) => {
						if (error) {
							reject(error)
							return
						}
						resolve()
					})
				})
			}
		}
		return { targets, ports }
	} finally {
		socket.close()
	}
}
