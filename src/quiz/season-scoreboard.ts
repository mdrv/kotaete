import { access, constants, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_STATE_DIR } from '../constants.ts'
import { getLogger } from '../logger.ts'
import { expandHome } from '../utils/path.ts'

const DEFAULT_SCOREBOARD_TEMPLATE_PATH = `${DEFAULT_STATE_DIR}/../scoreboard-template.svg`
const DEFAULT_AVATAR_DIR = `${DEFAULT_STATE_DIR}/../avatars`

const log = getLogger(['kotaete', 'quiz', 'scoreboard'])

/**
 * Escape XML special characters.
 */
function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

export type SeasonScoreboardSlot = {
	rank: number
	kananame: string
	nickname: string
	classgroup: string
	score: number
	mid?: string
}

/**
 * Render a season scoreboard SVG template with the given slots.
 * Replaces {{rank}}, {{kana}}, {{nickname}}, {{classgroup}}, {{score}} placeholders for each slot.
 * If fewer than 7 members, pads remaining slots with '...' placeholders (blank for nickname).
 */
export function renderSeasonScoreboardSvg(
	templateContent: string,
	slots: ReadonlyArray<SeasonScoreboardSlot>,
	opts?: { caption?: string },
): string {
	const totalSlots = 7
	let rendered = templateContent
	const caption = opts?.caption?.trim() ?? ''
	rendered = rendered.replaceAll('{{caption}}', escapeXml(caption))

	for (let i = 0; i < totalSlots; i++) {
		const slot = slots[i]
		const rank = slot?.rank ?? (i + 1)
		const kana = slot?.kananame ?? '...'
		const nickname = slot?.nickname ?? ''
		const classgroup = slot?.classgroup ?? '...'
		const score = slot?.score ?? 0

		const n = String(i + 1)
		rendered = rendered
			.replaceAll(`{{rank${n}}}`, String(rank))
			.replaceAll(`{{kana${n}}}`, escapeXml(kana))
			.replaceAll(`{{nickname${n}}}`, escapeXml(nickname))
			.replaceAll(`{{classgroup${n}}}`, escapeXml(classgroup))
			.replaceAll(`{{score${n}}}`, escapeXml(String(slot ? score : '...')))
	}

	return rendered
}

/**
 * Read a JPG file and return it as a base64 data URI string.
 * Returns null if the file does not exist or cannot be read.
 */
async function readAvatarAsDataUri(filePath: string): Promise<string | null> {
	try {
		await access(filePath, constants.R_OK)
		const buffer = await readFile(filePath)
		return `data:image/jpeg;base64,${buffer.toString('base64')}`
	} catch {
		return null
	}
}

/**
 * Embed avatar images into the SVG content by replacing xlink:href on #avatarN elements.
 * For each slot with a mid, looks up ~/.kotaete/avatars/<mid>.jpg, falls back to default.jpg.
 * If no avatar is found, keeps the original href unchanged.
 */
export async function embedAvatarDataUris(
	svgContent: string,
	slots: ReadonlyArray<SeasonScoreboardSlot>,
	avatarDir?: string,
): Promise<string> {
	const resolvedDir = expandHome(avatarDir ?? DEFAULT_AVATAR_DIR)
	const defaultAvatar = join(resolvedDir, 'default.jpg')
	let rendered = svgContent

	const totalSlots = 7
	for (let i = 0; i < totalSlots; i++) {
		const slot = slots[i]
		const mid = slot?.mid
		if (!mid) continue

		const n = String(i + 1)
		const memberAvatar = join(resolvedDir, `${mid}.jpg`)
		const dataUri = (await readAvatarAsDataUri(memberAvatar)) ?? await readAvatarAsDataUri(defaultAvatar)
		if (!dataUri) {
			log.debug(`no avatar found for slot ${n} (mid=${mid})`)
			continue
		}

		// Replace xlink:href on the element with id="avatar{N}"
		rendered = rendered.replace(
			new RegExp(`(\\s+xlink\\:href=["'])avatars/[^"']*(["'])\\s+id=["']avatar${n}["']`),
			` xlink:href="${dataUri}" id="avatar${n}"`,
		)
	}

	return rendered
}

/**
 * Build inkscape CLI arguments for scoreboard PNG export.
 */
export function buildSeasonScoreboardInkscapeArgs(outputPngPath: string, tmpSvgPath: string): string[] {
	return [
		'inkscape',
		`--export-filename=${outputPngPath}`,
		'--export-type=png',
		'--export-background=#ffffff',
		'--export-background-opacity=1',
		'--export-png-color-mode=RGB_8',
		tmpSvgPath,
	]
}

/**
 * Build ImageMagick args for scoreboard PNG -> JPG conversion.
 */
export function buildSeasonScoreboardMagickArgs(
	inputPngPath: string,
	outputJpgPath: string,
	quality = 85,
): string[] {
	return [
		'magick',
		inputPngPath,
		'-quality',
		String(quality),
		outputJpgPath,
	]
}

/**
 * Export a rendered SVG string to PNG first, then compress to JPG.
 * Returns both generated paths; JPG is intended for WhatsApp send.
 */
export async function exportSeasonScoreboardImage(
	svgContent: string,
	opts?: { outputDir?: string; outputStem?: string },
): Promise<{ pngPath: string; jpgPath: string }> {
	const outputDir = opts?.outputDir ? expandHome(opts.outputDir) : tmpdir()
	const stem = opts?.outputStem?.trim().length
		? opts.outputStem.trim()
		: `kotaete-season-scoreboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
	const pngPath = join(outputDir, `${stem}.png`)
	const jpgPath = join(outputDir, `${stem}.jpg`)

	const tmpSvgPath = join(
		tmpdir(),
		`kotaete-season-scoreboard-${Date.now()}-${Math.random().toString(36).slice(2)}.svg`,
	)

	await writeFile(tmpSvgPath, svgContent, 'utf-8')

	try {
		const inkscapeArgs = buildSeasonScoreboardInkscapeArgs(pngPath, tmpSvgPath)
		const inkscapeProc = Bun.spawn(inkscapeArgs, { stdout: 'pipe', stderr: 'pipe' })
		const inkscapeCode = await inkscapeProc.exited
		if (inkscapeCode !== 0) {
			const stderr = inkscapeProc.stderr ? await new Response(inkscapeProc.stderr).text() : ''
			throw new Error(`inkscape failed: ${stderr.trim() || `exit code ${inkscapeCode}`}`)
		}

		const magickArgs = buildSeasonScoreboardMagickArgs(pngPath, jpgPath, 85)
		const magickProc = Bun.spawn(magickArgs, { stdout: 'pipe', stderr: 'pipe' })
		const magickCode = await magickProc.exited
		if (magickCode !== 0) {
			const stderr = magickProc.stderr ? await new Response(magickProc.stderr).text() : ''
			throw new Error(`magick failed: ${stderr.trim() || `exit code ${magickCode}`}`)
		}
	} catch (error) {
		await unlink(pngPath).catch(() => undefined)
		await unlink(jpgPath).catch(() => undefined)
		await unlink(tmpSvgPath).catch(() => undefined)
		throw new Error(
			`[quiz] season scoreboard export failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	await unlink(tmpSvgPath).catch(() => undefined)
	return { pngPath, jpgPath }
}

/**
 * Load the scoreboard SVG template, render it with the given slots, and export to image.
 * Returns the path to the generated image file.
 */
export async function generateSeasonScoreboardImage(
	slots: ReadonlyArray<SeasonScoreboardSlot>,
	opts?: { templatePath?: string; outputDir?: string; outputStem?: string; caption?: string },
): Promise<{ pngPath: string; jpgPath: string }> {
	const resolvedTemplate = expandHome(opts?.templatePath ?? DEFAULT_SCOREBOARD_TEMPLATE_PATH)
	const templateContent = await readFile(resolvedTemplate, 'utf-8')
	const rendered = renderSeasonScoreboardSvg(templateContent, slots, {
		...(opts?.caption !== undefined ? { caption: opts.caption } : {}),
	})
	const withAvatars = await embedAvatarDataUris(rendered, slots)
	return await exportSeasonScoreboardImage(withAvatars, {
		...(opts?.outputDir ? { outputDir: opts.outputDir } : {}),
		...(opts?.outputStem ? { outputStem: opts.outputStem } : {}),
	})
}
