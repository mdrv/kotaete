import { describe, expect, test } from 'bun:test'
import { BaileysWhatsAppClient } from './baileys-client.ts'
import { parseWhatsAppProvider } from './types.ts'
import { WWebJsWhatsAppClient } from './wwebjs-client.ts'

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

	test('providers expose mapping lookup methods for tool fallback', () => {
		expect(typeof WWebJsWhatsAppClient.prototype.lookupPnByLid).toBe('function')
		expect(typeof WWebJsWhatsAppClient.prototype.lookupLidByPn).toBe('function')
		expect(typeof BaileysWhatsAppClient.prototype.lookupPnByLid).toBe('function')
		expect(typeof BaileysWhatsAppClient.prototype.lookupLidByPn).toBe('function')
	})
})
