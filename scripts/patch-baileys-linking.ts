import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PATCH_ROOT = path.resolve(process.cwd(), 'node_modules', '@whiskeysockets', 'baileys', 'lib')
const VALIDATE_CONNECTION = path.join(PATCH_ROOT, 'Utils', 'validate-connection.js')
const SOCKET_FILE = path.join(PATCH_ROOT, 'Socket', 'socket.js')

type PatchRule = {
	name: string
	from: RegExp
	to: string
}

const validateRules: PatchRule[] = [
	{
		name: 'login passive true -> false',
		from: /passive:\s*true,\s*\n(\s*)pull:\s*true/g,
		to: 'passive: false,\n$1pull: true',
	},
	{
		name: 'login lidDbMigrated false -> true',
		from: /lidDbMigrated:\s*false/g,
		to: 'lidDbMigrated: true',
	},
]

const socketRules: PatchRule[] = [
	{
		name: 'remove await noise.finishInit',
		from: /await\s+noise\.finishInit\(\);/g,
		to: 'noise.finishInit();',
	},
]

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')

const assertExists = (filePath: string): void => {
	if (!existsSync(filePath)) {
		throw new Error(`[baileys-patch] Required file not found: ${filePath}`)
	}
}

const applyRules = (source: string, rules: PatchRule[]): { next: string; changed: string[] } => {
	let next = source
	const changed: string[] = []

	for (const rule of rules) {
		const replaced = next.replace(rule.from, rule.to)
		if (replaced === next) continue
		next = replaced
		changed.push(rule.name)
	}

	return { next, changed }
}

const verifyPatched = (validateSource: string, socketSource: string): string[] => {
	const problems: string[] = []

	if (validateSource.includes('passive: true')) {
		problems.push('validate-connection.js still contains `passive: true`')
	}
	if (validateSource.includes('lidDbMigrated: false')) {
		problems.push('validate-connection.js still contains `lidDbMigrated: false`')
	}
	if (socketSource.includes('await noise.finishInit();')) {
		problems.push('socket.js still contains `await noise.finishInit();`')
	}

	return problems
}

const patch = async (): Promise<void> => {
	assertExists(VALIDATE_CONNECTION)
	assertExists(SOCKET_FILE)

	const [validateSource, socketSource] = await Promise.all([
		readFile(VALIDATE_CONNECTION, 'utf8'),
		readFile(SOCKET_FILE, 'utf8'),
	])

	if (checkOnly) {
		const problems = verifyPatched(validateSource, socketSource)
		if (problems.length === 0) {
			console.log('[baileys-patch] OK: linking patch present')
			return
		}

		for (const problem of problems) {
			console.error(`[baileys-patch] CHECK FAILED: ${problem}`)
		}

		process.exitCode = 1
		return
	}

	const validate = applyRules(validateSource, validateRules)
	const socket = applyRules(socketSource, socketRules)

	await Promise.all([
		writeFile(VALIDATE_CONNECTION, validate.next, 'utf8'),
		writeFile(SOCKET_FILE, socket.next, 'utf8'),
	])

	const problems = verifyPatched(validate.next, socket.next)
	if (problems.length > 0) {
		throw new Error(`[baileys-patch] Patch verification failed: ${problems.join('; ')}`)
	}

	const changed = [...validate.changed, ...socket.changed]
	if (changed.length > 0) {
		console.log(`[baileys-patch] Applied: ${changed.join(', ')}`)
	} else {
		console.log('[baileys-patch] Already patched; no changes made')
	}
}

try {
	await patch()
} catch (error) {
	console.error(`[baileys-patch] Fatal: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
}
