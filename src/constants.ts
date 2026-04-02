export const APP_NAME = 'NIPBANG Kotaete'
export const DEFAULT_AUTH_DIR = `${process.env.HOME ?? '~'}/.kotaete/auth/wwebjs`
export const DEFAULT_BAILEYS_AUTH_DIR = `${process.env.HOME ?? '~'}/.kotaete/auth/baileys`
export const DEFAULT_WWEBJS_AUTH_DIR = `${process.env.HOME ?? '~'}/.kotaete/auth/wwebjs`
export const DEFAULT_STATE_DIR = `${process.env.HOME ?? '~'}/.kotaete/state`
export const DEFAULT_LID_PN_MAP_PATH = `${DEFAULT_STATE_DIR}/lid-pn-map.json`
export const DEFAULT_SOCKET_PATH = `${process.env.HOME ?? '~'}/.kotaete/daemon.sock`
export const DEFAULT_WHATSAPP_PROVIDER = 'wwebjs' as const

export const QUESTION_TIMEOUT_MS = 60 * 60 * 1000
export const COOLDOWN_MS = 30 * 60 * 1000
export const OUTBOUND_QUEUE_INTERVAL_MS = 5 * 1000
export const POINTS_PER_WRONG_ANSWER = 1
export const POINTS_NORMAL_CAP = 10

export const REACTION_CORRECT = '✅'
export const REACTION_COOLDOWN = '⏰'
export const REACTION_NO_MORE_CHANCE = '🙊'
export const REACTION_WRONG_STREAK: ReadonlyArray<string> = ['2️⃣', '1️⃣', '🙊']

export const SPECIAL_STAGE_NUMBER = 99
export const POINTS_SPECIAL = 25

export const CLI_SESSION_SCOPE = 'nipbang-kotaete'
