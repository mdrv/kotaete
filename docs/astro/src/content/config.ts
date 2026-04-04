import { glob } from 'astro/loaders'
import { defineCollection, z } from 'astro:content'

const docs = defineCollection({
	loader: glob({
		pattern: ['*.md', 'releases/*.md'],
		base: '../../docs',
		generateId: ({ entry }) => entry.replace(/\.md$/, ''),
	}),
	schema: z.object({
		title: z.string().optional(),
	}),
})

export const collections = { docs }
