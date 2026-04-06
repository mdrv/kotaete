/**
 * NIPBANG Kotaete — Example Configuration
 *
 * This file demonstrates every available option in a kotaete.ts config.
 * Copy and adapt it for your own quiz directory.
 *
 * Usage:
 *   1. Place as `kotaete.ts` inside a quiz directory (e.g. `~/.kotaete/w20260405/`)
 *   2. Adjust dates, group ID, questions, and members to match your event
 *   3. Run: bun run daemon  (or bun run daemon:baileys)
 */
import { defineConfig } from './src/quiz/loader.ts'

export default defineConfig({
	// ─── WhatsApp Group ───────────────────────────────────────────────
	// The group JID where the quiz will run.
	groupId: '120363XXXXXXXXXX@g.us',

	// ─── Season (optional) ────────────────────────────────────────────
	// Tracks cumulative scores across multiple quiz sessions.
	season: {
		// Whether to auto-start the season when this quiz begins.
		start: true,
		// Whether to auto-end the season when this quiz finishes.
		end: false,
		// Display caption for the season scoreboard.
		caption: 'Kotaete S1: Apr 4 – Apr 10',
		// Optional: custom HTML scoreboard template path.
		// scoreboardTemplate: './scoreboard.html',
	},

	// ─── Schedule ─────────────────────────────────────────────────────
	// All times use WIB (Asia/Jakarta, UTC+7).
	// Intro message sent before the first round starts.
	intro: new Date('2026-04-05T11:15+07:00'),

	// Rounds define when each batch of questions begins.
	rounds: [
		{
			emoji: '🏞️',
			start: new Date('2026-04-05T11:30+07:00'),
			// Questions 1–3 (inclusive) belong to this round.
			questionRange: [1, 3],
			// Question number that triggers the god/special stage.
			// Must correspond to a question defined below.
			godStage: 98,
		},
		{
			emoji: '🏙️',
			start: new Date('2026-04-05T15:45+07:00'),
			questionRange: [4, 6],
		},
	],

	// ─── Message Template Overrides (optional) ────────────────────────
	// Override any default WhatsApp message. Supports {placeholder} syntax.
	// The godStageAnnouncement supports: {points}, {timeoutMinutes}, {delayMinutes}
	// (these resolve from QUIZ_TUNABLES at runtime).
	messages: {
		// Custom intro header (shown at quiz start).
		introHeader: '🚀 *はやくこたえて！ START*',

		// Per-round line in the intro message.
		introRoundLine: '- {emoji} {time} (x{count})',

		// God stage announcement — shown before the special question.
		// Placeholders: {points}, {timeoutMinutes}, {delayMinutes}
		godStageAnnouncement: [
			'🚨 *INCOMING!* 🚨',
			'🪽 *神のステージ (Kami no Stage)*',
			'',
			'Khusus stage ini, ketentuannya:',
			'🌸 Jawaban benar = {points} poin!',
			'🥳 Siapa pun bisa jawab! (no cooldown)',
			'🙈 Cuma 1x kesempatan per anggota',
			'⏰ Timeout soal {timeoutMinutes} menit',
			'',
			'🐻 Soal akan muncul dalam {delayMinutes} menit!',
		].join('\n'),

		// Notice sent between rounds.
		nextRoundNotice: 'Ronde berikutnya mulai pukul {time} WIB. Bersiaplah!',

		// Footer shown with each question (deadline hint).
		questionFooter: '⏰ Batas waktu: {time} WIB',

		// Shown when a player tries to answer during cooldown.
		cooldownWarning: 'Baru bisa jawab lagi mulai {time} WIB!',

		// Warning sent 10 minutes before question timeout.
		questionWarning: '⏰ Tinggal 10 menit lagi!',

		// Shown when time runs out for a question.
		timeout: '⏱️ Waktu habis untuk soal ini.\n✅ {answers}',

		// Shown when someone answers correctly.
		winner: '🤗 *せいかいだった！*\n🌸 *{name}({classgroup})* _+{points}pts_\n✅ {answers}',

		// Shown when someone answers perfectly (all answer types correct).
		winnerPerfect: '🤩 *かんぺきだった！*\n🌸 *{name}({classgroup})* _+{points}pts_\n✅ {answers}',

		// Tease message when romaji answer is missing.
		romajiTease: 'Kayaknya ada yang kelupaan...',

		// Explanation shown after a question is answered/timed out.
		explanation: '🌻 *_Shitteimasu ka?_* *({progress})*\n{text}',

		// Special explanation format for god-stage questions.
		explanationSpecial: '🌻 *_Shitteimasu ka?_* *(神)*\n{text}',

		// Break-mode scoreboard header.
		breakHeader: '☕ *はやくこたえて！ BREAK*',

		// Final scoreboard header.
		finalHeader: '🏁 *はやくこたえて！ END*',

		// Per-player row in the final scoreboard.
		finalRow: '- *{name}({classgroup})* 🌸 *+{points} pts*',

		// Shown when no one scored any points.
		finalEmpty: '(_tidak ada yang meraih poin_)',

		// Default footer for the final scoreboard.
		finalFooterDefault: '🐻 * _gao gao, gao!_ *',
		// Custom intro note (appended after intro header).
		// Takes priority over intro.md file in the quiz directory.
		// intro: 'Selamat datang di quiz hari ini!\n\nPeraturan:\n- Jawab dengan cepat!\n- Gunakan kana, romaji, atau kanji.',

		// Custom outro note (appended after final scoreboard).
		// Takes priority over outro.md file in the quiz directory.
		// outro: 'Terima kasih sudah berpartisipasi! 🎉',
	},

	// ─── Questions ────────────────────────────────────────────────────
	// Each question has a number, hint, answers, explanation, and optional image.
	//
	// Answer types (at least one required):
	//   kana   — Japanese reading in kana/katakana
	//   romaji — Romanized reading + kana type (e.g. "ringo hiragana")
	//   kanji  — Kanji representation
	//
	// Each answer can be a plain string or { text, extraPts? } for bonus points.
	// extraPts awards bonus points on top of the correct answer score.
	questions: [
		// ── Question 1: Full example with all answer types + extraPts ──
		{
			no: 1,
			hint: '＿ス',
			answers: {
				// Kana answer with bonus points
				kana: {
					text: 'リス',
					extraPts: 2,
				},
				// Plain romaji answer (no bonus)
				romaji: 'risu katakana',
				// Kanji answer (plain, no bonus)
				kanji: '栗鼠',
			},
			explanation:
				'*リス*(_risu_) = tupai\nMeskipun terdapat bentuk kanji serta hiragana, リス seringkali dituliskan dalam katakana (salah satu alasannya karena mudah ditulis).\n\n✨ Contohnya:\n*リスを見ました*\n_risu wo mimashita_\n(Saya) telah melihat tupai.',
			// Image metadata — used with SVG template to generate question images.
			image: {
				credit: 'Sousou no Frieren (2023)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},

		// ── Question 2: Minimal example (kana + romaji only) ──
		{
			no: 2,
			hint: '＿ン',
			answers: {
				kana: 'パン',
				romaji: 'pan katakana',
			},
			explanation:
				'*パン* (_pan_) = roti\nFrasa パン sendiri berasal dari bahasa Portugis yang bertuliskan "pão".\n\n✨ Contohnya:\n*パンが柔らかいです*\n_pan ga yawarakai desu_\nRoti (itu) lembut.',
			image: {
				credit: 'Jinrui wa Suitai Shimashita (2012)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},

		// ── Question 3: With kanji bonus ──
		{
			no: 3,
			hint: '＿る',
			answers: {
				kana: 'さばく',
				romaji: 'sabaku hiragana',
				kanji: {
					text: '砂漠',
					extraPts: 2,
				},
			},
			explanation:
				'*砂漠* (_sabaku_) = gurun pasir\n\n✨ Contohnya:\n*砂漠はとても暑い*\n_sabaku ha totemo atsui_\nGurun pasir (itu) sangat panas.',
			image: {
				credit: 'Apocalypse Hotel (2025)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},

		// ── Question 4: Another kanji bonus example ──
		{
			no: 4,
			hint: '＿で',
			answers: {
				kana: 'うで',
				romaji: 'ude hiragana',
				kanji: {
					text: '腕',
					extraPts: 2,
				},
			},
			explanation: '*腕* (_ude_) = lengan\n\n✨ Contohnya:\n*腕が痛いです*\n_ude ga itai desu_\nLengan (saya) sakit.',
			image: {
				credit: 'Jibaku Shounen Hanako-kun (2020)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},

		// ── Question 5: Longer hint ──
		{
			no: 5,
			hint: '＿＿う',
			answers: {
				kana: 'りそう',
				romaji: 'risou hiragana',
				kanji: {
					text: '理想',
					extraPts: 2,
				},
			},
			explanation:
				'*理* (_ri_) = alasan\n*想* (_sou_) = pikiran\n*理想* (_risou_) = ideal (standar)\n\n✨ Contohnya:\n*理想が高いですね*\n_risou ga takai desu ne_\nStandar (ideal) kamu tinggi ya.',
			image: {
				credit: 'Sumikko Gurashi: Koko ga Ochitsukun desu (2025)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},

		// ── Question 6: Three-character hint ──
		{
			no: 6,
			hint: '＿＿＿の',
			answers: {
				kana: 'かいもの',
				romaji: 'kaimono hiragana',
				kanji: {
					text: '買い物',
					extraPts: 2,
				},
			},
			explanation:
				'*買い物* (_kaimono_) = kegiatan belanja/belanjaan\n\n✨ Contohnya:\n*買い物をしすぎて、腕がパンパンです*\n_kaimono wo shisugite, ude ga panpan desu.)_\nKebanyakan belanja, lengan (saya) jadi pegal.',
			image: {
				credit: 'Maid-san wa Taberu dake (2026)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},

		// ── Question 98: God/Special Stage ──
		// This question is triggered by godStage: 98 in the first round.
		// It uses fixed scoring (QUIZ_TUNABLES.points.special, default 15),
		// no cooldown, one attempt per member, and 30-minute timeout.
		{
			no: 98,
			hint: '＿＿＿び',
			answers: {
				kana: 'たかとび',
				romaji: 'takatobi hiragana',
				kanji: {
					text: '高跳び',
					extraPts: 5,
				},
			},
			explanation:
				'*高い* (_takai_) = tinggi/mahal\n*飛び* (_tobi_) = lompatan\n*高跳び* (_takatobi_) = lompat tinggi\n\n✨ Contohnya:\n*学校で高跳びを練習する*\n_gakkou de takatobi wo renshuu suru_\nDi sekolah (saya akan) berlatih lompat tinggi.',
			image: {
				// Use the god-stage SVG template instead of the default one.
				god: true,
				credit: 'Hanazakari no Kimitachi e (2026)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},
	],
	// ─── Members (optional) ───────────────────────────────────────────
	// Can be an inline array or a file path (relative to quiz dir or absolute).
	// If omitted, all group participants are included.
	//
	// Inline example:
	// members: [
	// 	{
	// 		mid: 'member-1',
	// 		kananame: 'タロウ',
	// 		nickname: 'Taro',
	// 		classgroup: '1A',
	// 		lid: '1234567890@lid',
	// 	},
	// ],
	//
	// File reference example:
	// members: './members.ts',

	// ─── Image Templates (optional) ───────────────────────────────────
	// SVG templates used to generate question images.
	// Defaults to ~/.kotaete/template.svg and ~/.kotaete/template-god.svg.
	// imageTemplates: {
	// 	default: './template.svg',
	// 	god: './template-god.svg',
	// },
	//
	// Legacy aliases (also supported):
	// template: './template.svg',
	// templateGod: './template-god.svg',
})
