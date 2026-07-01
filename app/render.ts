import { createHtmlResponse } from 'remix/response/html'

export function render(
	body: Parameters<typeof createHtmlResponse>[0],
	init?: ResponseInit,
) {
	return createHtmlResponse(body, init)
}
