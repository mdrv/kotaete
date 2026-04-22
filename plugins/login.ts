import { generateDailyTotp4 } from '@mdrv/id'
import { definePlugin } from '../src/plugin/define-plugin.ts'

/**
 * Format a date as Indonesian-style string: "17 Mei 2026"
 */
function formatTodayWib(now = new Date()): string {
	const months = [
		'Januari',
		'Februari',
		'Maret',
		'April',
		'Mei',
		'Juni',
		'Juli',
		'Agustus',
		'September',
		'Oktober',
		'November',
		'Desember',
	]
	// WIB = UTC+7
	const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000)
	return `${wib.getUTCDate()} ${months[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`
}

type Surreal = import('surrealdb').Surreal

type MemberRecord = {
	id: string
	mids: Array<{ value: string; primary: boolean }>
	totp_secret?: string | null
	meta?: { whatsapp_lid?: string } | null
}

export default definePlugin({
	name: 'login',
	version: '1.0.0',
	description: 'DM /login command — look up MEDRIVIA ID and return TOTP code',

	async setup(ctx, args) {
		const endpoint = args['endpoint'] ?? 'http://localhost:596/rpc'
		const username = args['username'] ?? 'ua'
		const password = args['password'] ?? 'japan8'
		const namespace = args['namespace'] ?? 'medrivia'
		const database = args['database'] ?? 'id'

		let db: Surreal | null = null

		async function getDb(): Promise<Surreal> {
			if (db) return db
			const { Surreal } = await import('surrealdb') as typeof import('surrealdb')
			const instance = new Surreal()
			await instance.connect(endpoint)
			await instance.signin({ username, password })
			await instance.use({ namespace, database })
			db = instance
			return db
		}

		return {
			async onIncomingDmMessage({ message }) {
				const text = message.text.trim()
				if (text !== '/login') return

				const senderLid = message.senderLid
				if (!senderLid) {
					ctx.log.warn('login: no sender LID in DM, cannot look up member')
					await ctx.sendDmText(
						message.senderJid,
						'⚠️ Could not identify your WhatsApp account. Please try again later.',
					)
					return
				}

				try {
					const conn = await getDb()
					const rows = await conn.query<MemberRecord[]>(
						'SELECT id, mids, totp_secret, meta FROM member WHERE meta.whatsapp_lid = $lid LIMIT 1',
						{ lid: senderLid },
					)

					const rec = (rows as any)?.[0]?.[0] as MemberRecord | undefined
					if (!rec || !rec.totp_secret) {
						ctx.log.info(`login: no member found for LID=${senderLid}`)
						await ctx.sendDmText(
							message.senderJid,
							'❌ Akun tidak ditemukan. Pastikan WhatsApp ID kamu sudah terdaftar.',
						)
						return
					}

					const primaryMid = (rec.mids as Array<{ value: string; primary: boolean }>)
						?.find((m) => m.primary)?.value
						?? (rec.mids as Array<{ value: string; primary: boolean }>)?.[0]?.value
						?? '???'

					const code = generateDailyTotp4(String(rec.totp_secret))

					await ctx.sendDmText(
						message.senderJid,
						`MEDRIVIA ID:\n\n🪪 \`${primaryMid}\`\n🔑 \`${code}\`\n📅 ${formatTodayWib()}`,
					)

					ctx.log.info(`login: sent code for LID=${senderLid} mid=${primaryMid}`)
				} catch (error) {
					ctx.log.error(
						`login: DB error: ${error instanceof Error ? error.message : String(error)}`,
					)
					await ctx.sendDmText(
						message.senderJid,
						'⚠️ Server error. Please try again later.',
					)
				}
			},

			teardown() {
				if (db) {
					void db.close()
					db = null
				}
			},
		}
	},
})
