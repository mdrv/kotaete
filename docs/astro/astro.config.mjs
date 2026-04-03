import { defineConfig } from 'astro/config'

export default defineConfig({
	site: process.env.SITE_URL || 'https://example.github.io/nipbang-kotaete/',
	outDir: '../../_docs-dist',
	base: process.env.BASE_PATH || '/',
})
