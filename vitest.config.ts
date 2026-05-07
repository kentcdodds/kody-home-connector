import { defineConfig } from 'vitest/config'

const testTimeout = process.env.CI ? 20_000 : 5_000

export default defineConfig({
	oxc: {
		target: 'es2023',
		jsx: {
			runtime: 'automatic',
			importSource: 'remix/ui',
		},
	},
	test: {
		name: 'node-unit',
		environment: 'node',
		include: ['**/*.node.test.ts'],
		testTimeout,
		hookTimeout: testTimeout,
		fileParallelism: false,
		clearMocks: true,
	},
})
