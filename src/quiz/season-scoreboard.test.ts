import { describe, expect, test } from 'bun:test'
import {
	buildSeasonScoreboardInkscapeArgs,
	buildSeasonScoreboardMagickArgs,
	renderSeasonScoreboardSvg,
} from './season-scoreboard.ts'

describe('season scoreboard helpers', () => {
	test('buildSeasonScoreboardInkscapeArgs exports PNG with white background', () => {
		const args = buildSeasonScoreboardInkscapeArgs('/quiz/season-scoreboard.png', '/tmp/scoreboard.svg')
		expect(args).toContain('inkscape')
		expect(args).toContain('--export-type=png')
		expect(args).toContain('--export-background=#ffffff')
		expect(args).toContain('--export-background-opacity=1')
		expect(args).toContain('--export-png-color-mode=RGB_8')
		expect(args).toContain('--export-filename=/quiz/season-scoreboard.png')
		expect(args[args.length - 1]).toBe('/tmp/scoreboard.svg')
	})

	test('buildSeasonScoreboardMagickArgs converts PNG to JPG with quality', () => {
		const args = buildSeasonScoreboardMagickArgs('/quiz/season-scoreboard.png', '/quiz/season-scoreboard.jpg', 85)
		expect(args).toEqual([
			'magick',
			'/quiz/season-scoreboard.png',
			'-quality',
			'85',
			'/quiz/season-scoreboard.jpg',
		])
	})

	test('renderSeasonScoreboardSvg fills known slots and pads the rest', () => {
		const template = [
			'caption={{caption}}',
			'{{rank1}}|{{kana1}}|{{nickname1}}|{{classgroup1}}|{{score1}}',
			'{{rank2}}|{{kana2}}|{{nickname2}}|{{classgroup2}}|{{score2}}',
			'{{rank7}}|{{kana7}}|{{nickname7}}|{{classgroup7}}|{{score7}}',
		].join('\n')

		const rendered = renderSeasonScoreboardSvg(
			template,
			[
				{ rank: 1, kananame: 'アリ', nickname: 'Ari', classgroup: '10B', score: 123 },
				{ rank: 2, kananame: '<タグ>', nickname: 'A&B', classgroup: '8C', score: 77 },
			],
			{ caption: '<Musim & Final>' },
		)

		expect(rendered).toContain('caption=&lt;Musim &amp; Final&gt;')
		expect(rendered).toContain('1|アリ|Ari|10B|123')
		expect(rendered).toContain('2|&lt;タグ&gt;|A&amp;B|8C|77')
		expect(rendered).toContain('7|-|-|-|-')
	})
})
