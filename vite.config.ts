import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	test: {
		include: ['tests/**/*.test.ts'],
		alias: {
			// Resolve SvelteKit path aliases so tests can import $lib/*
			'$lib': '/src/lib',
			// Stub out $env so server modules that import it don't crash in unit tests
			'$env/dynamic/private': '/tests/__mocks__/env.ts',
		},
	},
});
