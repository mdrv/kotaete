import { createHmac } from 'node:crypto'

export function base32Decode(input: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
	const clean = input.toUpperCase().replace(/=+$/g, '')
	let bits = ''
	for (const ch of clean) {
		const idx = alphabet.indexOf(ch)
		if (idx < 0) continue
		bits += idx.toString(2).padStart(5, '0')
	}
	const bytes: number[] = []
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		bytes.push(parseInt(bits.slice(i, i + 8), 2))
	}
	return new Uint8Array(bytes)
}

export function dailyCounterGmt7(nowMs = Date.now()): bigint {
	const offsetMs = 7 * 60 * 60 * 1000
	const dayMs = 24 * 60 * 60 * 1000
	return BigInt(Math.floor((nowMs + offsetMs) / dayMs))
}

export function generateDailyTotp4(secretBase32: string, nowMs = Date.now()): string {
	const key = Buffer.from(base32Decode(secretBase32))
	const counter = dailyCounterGmt7(nowMs)
	const msg = Buffer.alloc(8)
	msg.writeBigUInt64BE(counter)
	const digest = createHmac('sha1', key).update(msg).digest()
	const offset = digest[digest.length - 1]! & 0x0f
	const code = (((digest[offset]! & 0x7f) << 24)
		| ((digest[offset + 1]! & 0xff) << 16)
		| ((digest[offset + 2]! & 0xff) << 8)
		| (digest[offset + 3]! & 0xff))
		% 10000
	return code.toString().padStart(4, '0')
}

/**
 * Compute the milliseconds remaining until the next TOTP code rotation
 * (midnight GMT+7). Returns ms remaining in the current 24-hour window.
 */
export function msUntilNextTotp(nowMs = Date.now()): number {
	const offsetMs = 7 * 60 * 60 * 1000
	const dayMs = 24 * 60 * 60 * 1000
	const currentDayOffset = (nowMs + offsetMs) % dayMs
	return dayMs - currentDayOffset
}
