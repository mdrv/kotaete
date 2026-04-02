import { describe, expect, test } from 'bun:test'
import { parseWhatsAppProvider } from './types.ts'

describe('parseWhatsAppProvider', () => {
	test('returns default provider when input is undefined', () => {
		expect(parseWhatsAppProvider(undefined)).toBe('wwebjs')
	})

	test('accepts explicit providers', () => {
		expect(parseWhatsAppProvider('wwebjs')).toBe('wwebjs')
		expect(parseWhatsAppProvider('baileys')).toBe('baileys')
	})

	test('throws on unsupported provider value', () => {
		expect(() => parseWhatsAppProvider('unknown')).toThrow("unsupported provider 'unknown'")
	})
})
