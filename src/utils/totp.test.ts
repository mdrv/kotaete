import { describe, expect, test } from 'bun:test'
import { base32Decode, dailyCounterGmt7, generateDailyTotp4, msUntilNextTotp } from './totp'

describe('base32Decode', () => {
	test('decodes known test vector — first 5 bytes of "JBSWY3DP" = "Hello"', () => {
		// JBSWY3DP encodes 5 bytes: 'Hello'
		const result = base32Decode('JBSWY3DP')
		expect(new TextDecoder().decode(result)).toBe('Hello')
	})

	test('decodes empty string → empty Uint8Array', () => {
		const result = base32Decode('')
		expect(result).toBeInstanceOf(Uint8Array)
		expect(result.length).toBe(0)
	})

	test('handles lowercase input', () => {
		const upper = base32Decode('JBSWY3DP')
		const lower = base32Decode('jbswy3dp')
		expect(lower).toEqual(upper)
	})

	test('ignores padding characters', () => {
		const padded = base32Decode('JBSWY3DP====')
		const unpadded = base32Decode('JBSWY3DP')
		expect(padded).toEqual(unpadded)
	})

	test('skips invalid characters', () => {
		const withInvalid = base32Decode('JB SW Y3-DP')
		const clean = base32Decode('JBSWY3DP')
		expect(withInvalid).toEqual(clean)
	})

	test('single character "A" → empty (only 5 bits, not enough for a byte)', () => {
		const result = base32Decode('A')
		expect(Array.from(result)).toEqual([])
	})

	test('decodes "MY" → [0x66]', () => {
		// M=12 → 01100, Y=24 → 11000 → 10 bits: 0110011000 → first 8 bits = 01100110 = 0x66
		const result = base32Decode('MY')
		expect(Array.from(result)).toEqual([0x66])
	})
})

describe('dailyCounterGmt7', () => {
	test('midnight GMT+7 gives expected counter value', () => {
		// 2026-04-21T00:00:00+07:00 in epoch ms
		const midnightGmt7Ms = Date.parse('2026-04-21T00:00:00+07:00')
		const offsetMs = 7 * 60 * 60 * 1000
		const dayMs = 24 * 60 * 60 * 1000
		const expected = BigInt(Math.floor((midnightGmt7Ms + offsetMs) / dayMs))
		expect(dailyCounterGmt7(midnightGmt7Ms)).toBe(expected)
	})

	test('two timestamps in same GMT+7 day give same counter', () => {
		// 2026-04-21T10:00:00+07:00 and 2026-04-21T22:00:00+07:00
		const morning = Date.parse('2026-04-21T10:00:00+07:00')
		const evening = Date.parse('2026-04-21T22:00:00+07:00')
		expect(dailyCounterGmt7(morning)).toBe(dailyCounterGmt7(evening))
	})

	test('two timestamps in different GMT+7 days give different counters', () => {
		const day1 = Date.parse('2026-04-21T12:00:00+07:00')
		const day2 = Date.parse('2026-04-22T12:00:00+07:00')
		expect(dailyCounterGmt7(day1)).not.toBe(dailyCounterGmt7(day2))
	})

	test('just before and just after midnight GMT+7 give different counters', () => {
		// 23:59:59 and 00:00:00 of the next day
		const before = Date.parse('2026-04-21T23:59:59+07:00')
		const after = Date.parse('2026-04-22T00:00:00+07:00')
		expect(dailyCounterGmt7(before)).not.toBe(dailyCounterGmt7(after))
	})

	test('counter increases by exactly 1 between consecutive days', () => {
		const day1 = Date.parse('2026-04-21T12:00:00+07:00')
		const day2 = Date.parse('2026-04-22T12:00:00+07:00')
		expect(dailyCounterGmt7(day2) - dailyCounterGmt7(day1)).toBe(1n)
	})
})

describe('generateDailyTotp4', () => {
	const secret = 'JBSWY3DPEHPK3PXP'
	const fixedMs = Date.parse('2026-04-21T12:00:00+07:00')

	test('returns a 4-character string of digits', () => {
		const code = generateDailyTotp4(secret, fixedMs)
		expect(code).toHaveLength(4)
		expect(/^\d{4}$/.test(code)).toBe(true)
	})

	test('same secret + same timestamp produces same code (deterministic)', () => {
		const a = generateDailyTotp4(secret, fixedMs)
		const b = generateDailyTotp4(secret, fixedMs)
		expect(a).toBe(b)
	})

	test('different timestamps on same GMT+7 day produce same code', () => {
		const morning = Date.parse('2026-04-21T08:00:00+07:00')
		const evening = Date.parse('2026-04-21T20:00:00+07:00')
		expect(generateDailyTotp4(secret, morning)).toBe(generateDailyTotp4(secret, evening))
	})

	test('different secrets give different codes', () => {
		const otherSecret = 'GEZDGNBVGY3TQOJQ' // base32 of 'secret'
		expect(generateDailyTotp4(secret, fixedMs)).not.toBe(generateDailyTotp4(otherSecret, fixedMs))
	})

	test('different days produce different codes with high probability', () => {
		const day1 = Date.parse('2026-04-21T12:00:00+07:00')
		const day2 = Date.parse('2026-04-22T12:00:00+07:00')
		const code1 = generateDailyTotp4(secret, day1)
		const code2 = generateDailyTotp4(secret, day2)
		// With 4 digits (10000 possibilities) this should differ
		expect(code1).not.toBe(code2)
	})
})

describe('msUntilNextTotp', () => {
	test('returns a positive number', () => {
		const result = msUntilNextTotp(Date.parse('2026-04-21T12:00:00+07:00'))
		expect(result).toBeGreaterThan(0)
	})

	test('returns value less than 24 hours in ms', () => {
		const dayMs = 24 * 60 * 60 * 1000
		const result = msUntilNextTotp(Date.parse('2026-04-21T12:00:00+07:00'))
		expect(result).toBeLessThan(dayMs)
	})

	test('just after midnight GMT+7 returns approximately 24h', () => {
		const justAfterMidnight = Date.parse('2026-04-21T00:01:00+07:00')
		const result = msUntilNextTotp(justAfterMidnight)
		const dayMs = 24 * 60 * 60 * 1000
		const expected = dayMs - 60 * 1000 // 23h 59m
		expect(result).toBe(expected)
	})

	test('exactly at midnight GMT+7 returns full 24h', () => {
		const midnight = Date.parse('2026-04-21T00:00:00+07:00')
		const result = msUntilNextTotp(midnight)
		const dayMs = 24 * 60 * 60 * 1000
		expect(result).toBe(dayMs)
	})

	test('at 23:59:59.999 GMT+7 returns approximately 1ms', () => {
		const almostMidnight = Date.parse('2026-04-21T23:59:59.999+07:00')
		const result = msUntilNextTotp(almostMidnight)
		expect(result).toBe(1)
	})

	test('monotonically decreases within a day', () => {
		const t1 = Date.parse('2026-04-21T10:00:00+07:00')
		const t2 = Date.parse('2026-04-21T14:00:00+07:00')
		expect(msUntilNextTotp(t1)).toBeGreaterThan(msUntilNextTotp(t2))
	})
})
