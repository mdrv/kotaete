import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { NMember } from '../types.ts'
import { normalizeLid, normalizePhoneNumber } from '../utils/normalize.ts'

const memberSchema = z.object({
	mid: z.string().min(1),
	kananame: z.string().min(1),
	nickname: z.string().min(1),
	classgroup: z.string().min(1),
	pn: z.string().transform((v) => normalizePhoneNumber(v)).pipe(
		z.string().min(1, 'phone number must contain at least one digit'),
	).optional(),
	lid: z.string().min(1).transform((v) => {
		const normalized = normalizeLid(v)
		if (!normalized) {
			throw new z.ZodError([
				{ code: 'custom', path: ['lid'], message: 'lid must be a non-empty identifier' },
			])
		}
		return normalized
	}),
})

type MemberInput = z.input<typeof memberSchema>

/**
 * Load and validate members from a JSON file or a TS/JS module.
 *
 * JSON files are parsed directly. TS/JS files are imported via Bun's dynamic
 * `import()` and must have a default export that is an array of member-like objects.
 *
 * @throws {Error} when the file cannot be read, imported, or fails validation.
 */
export async function loadMembers(
	membersFile: string,
): Promise<ReadonlyArray<NMember>> {
	const absPath = resolve(membersFile)
	const ext = extname(absPath).toLowerCase()

	let raw: unknown

	if (ext === '.json') {
		const src = readFileSync(absPath, 'utf-8')
		raw = JSON.parse(src) as unknown
	} else if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
		const mod = await import(pathToFileURL(absPath).href) as { default?: unknown }
		if (typeof mod.default !== 'undefined') {
			raw = mod.default
		} else {
			throw new Error(
				`[members] "${absPath}" must have a default export`,
			)
		}
	} else {
		throw new Error(
			`[members] unsupported file extension "${ext}" for "${absPath}". Expected .json, .ts, .js, .mjs, or .cjs`,
		)
	}

	if (!Array.isArray(raw)) {
		throw new Error(
			`[members] expected an array in "${absPath}" but got ${typeof raw}`,
		)
	}

	const members: NMember[] = []
	const seenLids = new Set<string>()

	for (let i = 0; i < raw.length; i++) {
		const result = memberSchema.safeParse(raw[i] as MemberInput)
		if (!result.success) {
			const first = result.error.issues[0]
			const msg = first
				? first.message
				: 'unknown validation error'
			throw new Error(
				`[members] validation failed for member at index ${i}: ${msg}`,
			)
		}
		const parsed = result.data

		if (seenLids.has(parsed.lid)) {
			throw new Error(
				`[members] duplicate lid "${parsed.lid}" at index ${i}`,
			)
		}
		seenLids.add(parsed.lid)

		const member: NMember = {
			mid: parsed.mid,
			kananame: parsed.kananame,
			nickname: parsed.nickname,
			classgroup: parsed.classgroup,
			lid: parsed.lid,
			...(parsed.pn ? { pn: parsed.pn } : {}),
		}
		members.push(member)
	}

	return members
}
