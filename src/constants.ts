export const APP_NAME = 'NIPBANG Kotaete'
export const DEFAULT_AUTH_DIR = `${process.env.HOME ?? '~'}/.kotaete/auth/wwebjs`
export const DEFAULT_BAILEYS_AUTH_DIR = `${process.env.HOME ?? '~'}/.kotaete/auth/baileys`
export const DEFAULT_WWEBJS_AUTH_DIR = `${process.env.HOME ?? '~'}/.kotaete/auth/wwebjs`
export const DEFAULT_STATE_DIR = `${process.env.HOME ?? '~'}/.kotaete/state`
export const DEFAULT_LID_PN_MAP_PATH = `${DEFAULT_STATE_DIR}/lid-pn-map.json`
export const DEFAULT_SOCKET_PATH = `${process.env.HOME ?? '~'}/.kotaete/daemon.sock`
export const DEFAULT_DAEMON_LOCK_PATH = `${process.env.HOME ?? '~'}/.kotaete/daemon.lock`
export const DEFAULT_DAEMON_RUNTIME_STATE_PATH = `${DEFAULT_STATE_DIR}/daemon-runtime.json`
export const DEFAULT_WHATSAPP_PROVIDER = 'wwebjs' as const

// ---------------------------------------------------------------------------
// Quiz tunables — organized config tree
// ---------------------------------------------------------------------------

export const QUIZ_TUNABLES = {
	timeout: {
		/** Normal question timeout in ms (default: 60 min) */
		normalMs: 60 * 60 * 1000,
		/** Special/god stage question timeout in ms (default: 30 min) */
		specialMs: 30 * 60 * 1000,
		/** How far before deadline to send the warning message (default: 10 min) */
		warningLeadMs: 10 * 60 * 1000,
		/** Delay before sending the god-stage question after announcement (default: 1 min) */
		godAnnounceDelayMs: 60 * 1000,
	},
	cooldown: {
		/** Cooldown duration in ms after a correct answer (default: 30 min) */
		ms: 30 * 60 * 1000,
	},
	points: {
		/** Points awarded per wrong answer (normal stage only) */
		perWrong: 1,
		/** Maximum total points for a correct answer in normal stage */
		normalCap: 10,
		/** Fixed points for a correct answer in special/god stage */
		special: 15,
		/** Bonus points when the correct answer contains kanji */
		kanjiBonus: 2,
	},
	wrongAttempts: {
		/** Number of wrong answers allowed per player per question (normal stage) */
		maxCount: 2,
		/** Emojis to show for each remaining wrong attempt (index 0 = first wrong, etc.) */
		emojiStreak: ['2️⃣', '1️⃣', '🙊'] as ReadonlyArray<string>,
	},
	stage: {
		/** Question number that triggers special/god stage behavior */
		specialNumber: 99,
	},
} as const

export type QuizTunables = typeof QUIZ_TUNABLES

// ---------------------------------------------------------------------------
// Backward-compatible flat aliases (still exported for minimal churn)
// ---------------------------------------------------------------------------

export const QUESTION_TIMEOUT_MS = QUIZ_TUNABLES.timeout.normalMs
export const QUESTION_WARNING_LEAD_MS = QUIZ_TUNABLES.timeout.warningLeadMs
export const COOLDOWN_MS = QUIZ_TUNABLES.cooldown.ms
export const OUTBOUND_QUEUE_INTERVAL_MS = 5 * 1000
export const POINTS_PER_WRONG_ANSWER = QUIZ_TUNABLES.points.perWrong
export const POINTS_NORMAL_CAP = QUIZ_TUNABLES.points.normalCap

export const REACTION_CORRECT = '✅'
export const REACTION_CORRECT_KANJI = '🌸'
export const REACTION_COOLDOWN = '⏰'
export const REACTION_NO_MORE_CHANCE = '🙊'
export const REACTION_WRONG_STREAK = QUIZ_TUNABLES.wrongAttempts.emojiStreak

export const POINTS_KANJI_BONUS = QUIZ_TUNABLES.points.kanjiBonus

export const SPECIAL_STAGE_NUMBER = QUIZ_TUNABLES.stage.specialNumber
export const POINTS_SPECIAL = QUIZ_TUNABLES.points.special

export const CLI_SESSION_SCOPE = '@mdrv/kotaete'

/** Flat alias: god/special stage question timeout */
export const GOD_STAGE_TIMEOUT_MS = QUIZ_TUNABLES.timeout.specialMs
/** Flat alias: delay before sending god-stage question after announcement */
export const GOD_STAGE_ANNOUNCE_DELAY_MS = QUIZ_TUNABLES.timeout.godAnnounceDelayMs
