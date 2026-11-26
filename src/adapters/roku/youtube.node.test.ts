import { expect, test } from 'vitest'
import { parseYouTubeVideoId } from './youtube.ts'

test.each([
	['https://youtu.be/_mAxik0v1A8?is=hhvkIitGxavHyTRe', '_mAxik0v1A8'],
	['https://youtu.be/dQw4w9WgXcQ?si=abc123', 'dQw4w9WgXcQ'],
	['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
	['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	[
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=10s&feature=share',
		'dQw4w9WgXcQ',
	],
	['https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	['https://www.youtube.com/shorts/aBcDeFgHiJk', 'aBcDeFgHiJk'],
	['https://www.youtube.com/live/aBcDeFgHiJk?si=x', 'aBcDeFgHiJk'],
	['https://www.youtube.com/embed/aBcDeFgHiJk', 'aBcDeFgHiJk'],
	['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	['https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x', 'dQw4w9WgXcQ'],
	['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	['  _mAxik0v1A8  ', '_mAxik0v1A8'],
])('parses %s', (input, expected) => {
	expect(parseYouTubeVideoId(input)).toBe(expected)
})

test('rejects playlist-only links', () => {
	expect(() =>
		parseYouTubeVideoId('https://www.youtube.com/playlist?list=PL1234567890'),
	).toThrow(/playlist link without a video id/)
})

test('rejects non-YouTube hosts', () => {
	expect(() =>
		parseYouTubeVideoId('https://vimeo.com/watch?v=dQw4w9WgXcQ'),
	).toThrow(/not a YouTube host/)
	expect(() =>
		parseYouTubeVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ'),
	).toThrow(/not a YouTube host/)
})

test('rejects empty input and links without an id', () => {
	expect(() => parseYouTubeVideoId('')).toThrow(/required/)
	expect(() => parseYouTubeVideoId('https://www.youtube.com/')).toThrow(
		/Could not find a YouTube video id/,
	)
})
