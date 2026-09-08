import {
	encodeNecPulses,
	flipperRawToGcPulses,
	hdmiSwitchPulseProfile,
	standardNecPulseProfile,
} from './ir.ts'
import {
	type GlobalCacheIrCommand,
	type GlobalCacheIrReliability,
	type GlobalCacheStatus,
} from './types.ts'

const hdmiSwitchNotes =
	'NEC address 0x4C on iTach IR1 (stick-on emitter on the MROCIOA HDMI switch). Inputs 1 and 2 were proven on the court. 3-5 follow the same command byte and are guessed.'

function hdmiInputCommand(
	input: 1 | 2 | 3 | 4 | 5,
	reliability: GlobalCacheIrReliability,
): GlobalCacheIrCommand {
	const pulses = encodeNecPulses({
		address: 0x4c,
		command: input,
		profile: hdmiSwitchPulseProfile,
	})
	return {
		commandId: `hdmi-input-${String(input)}`,
		title: `HDMI switch input ${String(input)}`,
		target: 'hdmi-switch',
		connector: '1:1',
		portMode: 'IR',
		reliability,
		notes: hdmiSwitchNotes,
		freq: hdmiSwitchPulseProfile.freq,
		repeat: 2,
		pulses,
	}
}

function projectorCommand(input: {
	commandId: string
	title: string
	command: number
	notes: string
}): GlobalCacheIrCommand {
	const pulses = encodeNecPulses({
		address: 0x32,
		address2: 0xcd,
		command: input.command,
		profile: standardNecPulseProfile,
	})
	return {
		commandId: input.commandId,
		title: input.title,
		target: 'projector',
		connector: '1:2',
		portMode: 'IR',
		reliability: 'proven',
		notes: input.notes,
		freq: standardNecPulseProfile.freq,
		repeat: 2,
		pulses,
	}
}

const rotosphereFlipperRaw: Record<string, string> = {
	'black-out':
		'9121 4373 678 449 679 1565 679 449 706 1538 707 421 706 422 705 422 704 425 703 1540 703 449 678 449 678 450 677 1567 675 1568 676 1569 674 1570 674 453 675 453 675 453 675 453 674 453 675 453 675 454 674 453 675 1569 674 1570 674 1570 674 1570 674 1570 674 1569 674 1570 674 1570 674',
	auto: '9172 4327 676 450 678 1592 652 475 677 1567 676 451 677 451 676 451 677 450 677 1567 677 451 676 452 675 452 676 1569 675 1570 674 1570 674 1570 674 1570 674 453 675 453 675 453 675 453 675 453 675 453 675 453 674 453 675 1569 675 1569 675 1569 675 1569 675 1569 675 1570 674 1570 674',
	sound:
		'9150 4344 707 420 707 1536 733 394 733 1510 732 395 707 422 705 423 704 447 680 1564 679 448 679 449 677 451 676 1568 675 1568 676 1568 675 1569 675 452 676 1569 675 452 676 453 675 452 676 453 675 453 675 453 674 1569 675 453 675 1569 675 1569 675 1569 675 1569 675 1569 675 1569 674',
	strobe:
		'9138 4355 703 425 702 1541 703 425 703 1540 703 425 677 451 677 451 702 426 702 1542 702 428 699 450 677 451 676 1569 674 1570 674 1570 674 1570 674 1571 673 1571 673 454 674 454 674 454 673 454 674 454 673 454 674 454 673 454 674 1570 674 1570 674 1571 673 1571 673 1571 673 1570 674',
	speed:
		'9121 4372 679 448 679 1565 706 421 708 1536 708 420 733 395 733 394 732 396 705 1538 705 423 704 425 702 448 679 1565 678 1566 677 1567 676 1568 675 452 675 452 675 1569 674 452 676 452 675 453 675 453 675 453 675 1569 675 1569 675 453 675 1569 675 1569 675 1569 675 1569 675 1569 675',
	manual:
		'9091 4401 652 475 652 1591 652 475 652 1591 652 475 652 475 652 474 653 474 653 1590 653 474 677 450 677 451 677 1567 676 1568 675 1568 675 1569 675 1569 675 1569 675 1569 675 453 674 453 675 453 675 453 675 453 675 453 675 453 675 453 675 1569 675 1569 675 1569 675 1569 675 1569 675',
	fade: '9120 4373 679 448 680 1564 680 448 679 1565 679 448 679 449 679 449 679 449 678 1566 677 474 678 450 677 450 677 1567 676 1568 675 1568 675 1569 675 453 675 453 675 453 674 1569 675 453 675 453 675 453 675 453 675 1569 675 1569 675 1569 674 453 675 1569 674 1570 674 1569 675 1570 674',
	red: '9139 4357 677 451 677 1567 702 426 702 1543 702 427 701 450 677 451 676 453 674 1570 674 454 674 455 673 455 673 1572 673 1571 673 1571 673 1571 673 1571 673 455 673 455 673 1572 673 455 673 455 673 455 673 455 673 455 673 1572 673 1572 672 456 672 1572 673 1572 672 1572 673 1572 673',
	green:
		'9152 4345 707 420 708 1536 733 394 734 1510 734 395 706 421 707 422 705 423 704 1564 679 448 679 449 678 450 677 1567 677 1568 676 1569 675 1569 675 452 676 1569 675 453 675 1569 675 453 675 452 676 453 675 453 675 1569 675 453 675 1569 675 453 675 1570 674 1569 675 1570 674 1570 674',
	blue: '9124 4375 679 449 679 1566 679 449 679 1567 678 451 677 475 676 451 678 450 678 1568 676 452 676 452 676 453 675 1570 675 1570 675 1570 675 1570 675 1570 675 1570 675 453 675 1570 674 453 675 453 675 453 675 453 675 453 675 453 675 1570 675 454 674 1570 675 1570 675 1571 674 1571 674',
	white:
		'9127 4377 679 449 680 1567 678 475 653 1592 654 475 653 475 653 476 677 451 677 1569 677 452 676 453 676 453 676 1570 676 1571 675 1571 675 1571 675 453 676 1571 675 453 675 1571 675 1571 675 453 675 453 675 453 676 1571 675 454 675 1571 675 454 675 454 675 1571 675 1571 675 1571 675',
	plus: '9153 4361 731 398 679 1569 678 451 704 1544 703 427 702 429 700 451 677 452 677 1571 675 454 675 455 674 455 674 1573 674 1573 674 1573 674 1573 674 455 675 455 675 1573 675 1573 674 455 674 455 674 455 674 455 674 1574 674 1574 674 456 674 456 674 1574 674 1574 674 1574 673 1574 674',
	minus:
		'9158 4347 734 393 735 1512 733 395 708 1538 707 422 706 424 705 447 680 448 680 1567 678 450 678 451 677 452 676 1570 676 1570 676 1570 676 1570 676 453 676 1570 676 1570 676 1570 676 453 676 453 676 453 676 453 676 1571 675 453 676 453 676 453 676 1570 676 1571 675 1571 675 1571 675',
}

const rotosphereProven = new Set(['black-out', 'manual', 'red'])

const rotosphereTitles: Record<string, string> = {
	'black-out': 'Black Out',
	auto: 'Auto',
	sound: 'Sound',
	strobe: 'Strobe',
	speed: 'Speed',
	manual: 'Manual',
	fade: 'Fade',
	red: 'Red',
	green: 'Green',
	blue: 'Blue',
	white: 'White',
	plus: 'Plus',
	minus: 'Minus',
}

function rotosphereCommand(action: string): GlobalCacheIrCommand {
	const raw = rotosphereFlipperRaw[action]
	if (!raw) {
		throw new Error(`Missing Rotosphere Flipper raw for ${action}.`)
	}
	const reliability: GlobalCacheIrReliability = rotosphereProven.has(action)
		? 'proven'
		: 'unreliable-flipper'
	return {
		commandId: `rotosphere-${action}`,
		title: `Rotosphere ${rotosphereTitles[action] ?? action}`,
		target: 'rotosphere',
		connector: '1:3',
		portMode: 'IR_BLASTER',
		reliability,
		notes:
			'Chauvet IRC-6 via iTach IR3 hanging blaster, converted from Flipper ChauvetDJ_IRC6.ir. Black Out, Manual, and Red were observed on the court. Other buttons are best-effort and often do not match the handheld. Fixture IR must be enabled (SEt on). Circle back to learn the remaining buttons on the iTach pinhole.',
		freq: standardNecPulseProfile.freq,
		repeat: 2,
		pulses: flipperRawToGcPulses(raw),
	}
}

export const globalCacheIrCommands: Array<GlobalCacheIrCommand> = [
	hdmiInputCommand(1, 'proven'),
	hdmiInputCommand(2, 'proven'),
	hdmiInputCommand(3, 'guessed'),
	hdmiInputCommand(4, 'guessed'),
	hdmiInputCommand(5, 'guessed'),
	projectorCommand({
		commandId: 'projector-on',
		title: 'Projector power on',
		command: 0x02,
		notes:
			'Optoma install codeset 32 CD 02 on iTach IR2 (stick-on emitter). Lamp warmup can take 15-30s.',
	}),
	projectorCommand({
		commandId: 'projector-standby',
		title: 'Projector standby',
		command: 0x33,
		notes: 'Optoma install codeset 32 CD 33 on iTach IR2.',
	}),
	projectorCommand({
		commandId: 'projector-hdmi',
		title: 'Projector HDMI input',
		command: 0x16,
		notes: 'Optoma install codeset 32 CD 16 on iTach IR2.',
	}),
	...Object.keys(rotosphereFlipperRaw).map((action) =>
		rotosphereCommand(action),
	),
]

export const globalCachePortMap: GlobalCacheStatus['portMap'] = [
	{
		connector: '1:1',
		target: 'hdmi-switch',
		kind: 'emitter',
		notes: 'Stick-on emitter on the MROCIOA HDMI switch IR window.',
	},
	{
		connector: '1:2',
		target: 'projector',
		kind: 'emitter',
		notes: 'Stick-on emitter on the Optoma IR window.',
	},
	{
		connector: '1:3',
		target: 'rotosphere',
		kind: 'blaster',
		notes:
			'Hanging IR blaster aimed at the Chauvet Rotosphere. This jack must be IR_BLASTER.',
	},
]

export function getGlobalCacheIrCommand(
	commandId: string,
): GlobalCacheIrCommand {
	const command = globalCacheIrCommands.find(
		(entry) => entry.commandId === commandId,
	)
	if (!command) {
		throw new Error(
			`Unknown Global Cache IR command "${commandId}". Use globalcache_list_ir_commands.`,
		)
	}
	return command
}
