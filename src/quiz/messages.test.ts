import { describe, expect, test } from 'bun:test'
import type { NMember, QuizQuestion } from '../types.ts'
import {
	formatFinalScoreboard,
	formatIntro,
	formatQuestion,
	formatSeasonOthersMessage,
	formatSeasonTopMessage,
} from './messages.ts'

function makeMember(overrides: Partial<NMember> = {}): NMember {
	return {
		mid: '1',
		kananame: 'テスト',
		nickname: 'Test',
		classgroup: 'A',
		lid: '628111@lid',
		pn: '628111',
		...overrides,
	}
}

describe('formatIntro date header', () => {
	test('renders Japanese weekday + Indonesian date style', () => {
		const introAt = new Date(Date.UTC(2025, 8, 26, 17, 0, 0, 0)) // 2025-09-27 00:00 WIB
		const text = formatIntro(introAt, null)
		expect(text).toContain('🗓️ *土︱27 September 2025*')
	})

	test('hides progress marker for special stage', () => {
		const question: QuizQuestion = {
			number: 99,
			text: 'Special text',
			answers: ['ans'],
			explanation: '',
			imagePath: null,
			isSpecialStage: true,
		}
		const text = formatQuestion(question, null, '23.59')
		expect(text).toContain('🌈 *はやくこたえて！ (神)*')
		expect(text).not.toContain('(1/4)')
		expect(text).not.toContain('SPECIAL')
		expect(text).toContain('⏰ *23.59 WIB*')
	})

	test('uses outro note when provided', () => {
		const text = formatFinalScoreboard([], 'Custom outro footer', new Date(Date.UTC(2025, 8, 26, 17, 0, 0, 0)))
		expect(text).toContain('🗓️ *土︱27 September 2025*')
		expect(text).toContain('Custom outro footer')
		expect(text).not.toContain('gao gao, gao')
	})
})

describe('season message formatters', () => {
	test('formatSeasonTopMessage renders top 3 with medals', () => {
		const members = [
			{ member: makeMember({ kananame: 'アリ', nickname: 'Ari', classgroup: '10B' }), points: 50 },
			{ member: makeMember({ kananame: 'バニャ', nickname: 'Vanya', classgroup: '8B' }), points: 40 },
			{ member: makeMember({ kananame: 'ナディラ', nickname: 'Nadhila', classgroup: '10C' }), points: 30 },
			{ member: makeMember({ kananame: 'ララ', nickname: 'Rara', classgroup: '7B' }), points: 20 },
		]
		const text = formatSeasonTopMessage(members, 'Week 1')
		expect(text).toContain('🏆 *Hasil NIPBANG Kotaete!*')
		expect(text).toContain('_Week 1_')
		expect(text).toContain('🥇 *アリ/Ari (10B)*')
		expect(text).toContain('🥈 *バニャ/Vanya (8B)*')
		expect(text).toContain('🥉 *ナディラ/Nadhila (10C)*')
		expect(text).toContain('🎊 *みんな、おめでとう！* 🎊')
		expect(text).not.toContain('ララ')
	})

	test('formatSeasonTopMessage works without caption', () => {
		const members = [
			{ member: makeMember({ kananame: 'ア', nickname: 'A', classgroup: 'X' }), points: 10 },
		]
		const text = formatSeasonTopMessage(members)
		expect(text).toContain('🏆 *Hasil NIPBANG Kotaete!*')
		expect(text).not.toContain('_')
	})

	test('formatSeasonTopMessage handles empty list', () => {
		const text = formatSeasonTopMessage([])
		expect(text).toContain('🏆 *Hasil NIPBANG Kotaete!*')
	})

	test('formatSeasonOthersMessage renders members beyond top 3', () => {
		const members = [
			{ member: makeMember({ kananame: 'アリ', nickname: 'Ari', classgroup: '10B' }), points: 50 },
			{ member: makeMember({ kananame: 'バニャ', nickname: 'Vanya', classgroup: '8B' }), points: 40 },
			{ member: makeMember({ kananame: 'ナディラ', nickname: 'Nadhila', classgroup: '10C' }), points: 30 },
			{ member: makeMember({ kananame: 'ララ', nickname: 'Rara', classgroup: '7B' }), points: 20 },
			{ member: makeMember({ kananame: 'レンディ', nickname: 'Rendi', classgroup: '10B' }), points: 5 },
		]
		const text = formatSeasonOthersMessage(members)
		expect(text).toContain('🐻 _* gao gao gao! *_')
		expect(text).toContain('Selamat juga kepada partisipan lainnya!')
		expect(text).not.toContain('アリ')
		expect(text).toContain('🌸 *ララ/Rara (7B)* +20 pts')
		expect(text).toContain('🌸 *レンディ/Rendi (10B)* +5 pts')
	})

	test('formatSeasonOthersMessage handles exactly 3 members', () => {
		const members = [
			{ member: makeMember({ kananame: 'ア', nickname: 'A', classgroup: 'X' }), points: 30 },
			{ member: makeMember({ kananame: 'バ', nickname: 'B', classgroup: 'X' }), points: 20 },
			{ member: makeMember({ kananame: 'ナ', nickname: 'C', classgroup: 'X' }), points: 10 },
		]
		const text = formatSeasonOthersMessage(members)
		expect(text).toBeNull()
	})
})
