export type GlobalCacheIrReliability =
	| 'proven'
	| 'guessed'
	| 'unreliable-flipper'

export type GlobalCacheIrPortMode = 'IR' | 'IR_BLASTER'

export type GlobalCacheIrTarget = 'hdmi-switch' | 'projector' | 'rotosphere'

export type GlobalCacheIrCommand = {
	commandId: string
	title: string
	target: GlobalCacheIrTarget
	connector: '1:1' | '1:2' | '1:3'
	portMode: GlobalCacheIrPortMode
	reliability: GlobalCacheIrReliability
	notes: string
	freq: number
	repeat: number
	pulses: Array<number>
}

export type GlobalCacheSendIrResult = {
	commandId: string
	connector: string
	response: string
	setIrResponse: string | null
}

export type GlobalCacheStatus = {
	host: string
	port: number
	mocksEnabled: boolean
	portMap: Array<{
		connector: '1:1' | '1:2' | '1:3'
		target: GlobalCacheIrTarget
		kind: 'emitter' | 'blaster'
		notes: string
	}>
	commandCount: number
}

export type GlobalCacheCommandClient = (input: {
	command: string
	isComplete: (line: string, lines: Array<string>) => boolean
}) => Promise<Array<string>>
