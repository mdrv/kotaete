import { describe, expect, test } from 'bun:test'
import { buildBaileysMessageKey, extractInboundText, extractSenderJid } from './baileys-client.ts'

describe('extractInboundText', () => {
	test('returns empty for null/undefined/non-object', () => {
		expect(extractInboundText(null)).toBe('')
		expect(extractInboundText(undefined)).toBe('')
		expect(extractInboundText('string')).toBe('')
		expect(extractInboundText(42)).toBe('')
	})

	test('extracts direct conversation text', () => {
		expect(extractInboundText({ conversation: 'hello world' })).toBe('hello world')
	})

	test('returns empty for whitespace-only conversation', () => {
		expect(extractInboundText({ conversation: '   ' })).toBe('')
	})

	test('extracts extendedTextMessage text', () => {
		expect(extractInboundText({ extendedTextMessage: { text: 'extended reply' } })).toBe('extended reply')
	})

	test('returns empty for whitespace-only extendedTextMessage', () => {
		expect(extractInboundText({ extendedTextMessage: { text: '  ' } })).toBe('')
	})

	test('prefers conversation over extendedTextMessage', () => {
		expect(extractInboundText({ conversation: 'direct', extendedTextMessage: { text: 'extended' } })).toBe(
			'direct',
		)
	})

	test('unwraps ephemeralMessage', () => {
		const message = {
			ephemeralMessage: {
				message: { conversation: 'ephemeral text' },
			},
		}
		expect(extractInboundText(message)).toBe('ephemeral text')
	})

	test('unwraps viewOnceMessage', () => {
		const message = {
			viewOnceMessage: {
				message: { extendedTextMessage: { text: 'view once text' } },
			},
		}
		expect(extractInboundText(message)).toBe('view once text')
	})

	test('unwraps viewOnceMessageV2', () => {
		const message = {
			viewOnceMessageV2: {
				message: { conversation: 'view once v2' },
			},
		}
		expect(extractInboundText(message)).toBe('view once v2')
	})

	test('unwraps editedMessage', () => {
		const message = {
			editedMessage: {
				message: { conversation: 'edited text' },
			},
		}
		expect(extractInboundText(message)).toBe('edited text')
	})

	test('handles nested wrapping (ephemeralMessage → viewOnceMessage)', () => {
		const message = {
			ephemeralMessage: {
				message: {
					viewOnceMessage: {
						message: { conversation: 'deeply nested' },
					},
				},
			},
		}
		expect(extractInboundText(message)).toBe('deeply nested')
	})

	test('returns empty when wrapper contains no text', () => {
		const message = {
			ephemeralMessage: {
				message: { imageMessage: { url: 'https://example.com/img.jpg' } },
			},
		}
		expect(extractInboundText(message)).toBe('')
	})

	test('returns empty for empty object', () => {
		expect(extractInboundText({})).toBe('')
	})
})

describe('extractSenderJid', () => {
	test('prefers participant over alternates', () => {
		expect(
			extractSenderJid({
				participant: '123@g.us',
				participantAlt: '456@s.whatsapp.net',
				remoteJidAlt: '789@s.whatsapp.net',
			}),
		).toBe('123@g.us')
	})

	test('falls back to participantAlt when participant missing', () => {
		expect(
			extractSenderJid({
				participant: null,
				participantAlt: '456@s.whatsapp.net',
				remoteJidAlt: '789@s.whatsapp.net',
			}),
		).toBe('456@s.whatsapp.net')
	})

	test('falls back to remoteJidAlt when both participant and alt missing', () => {
		expect(
			extractSenderJid({
				participant: null,
				participantAlt: null,
				remoteJidAlt: '789@s.whatsapp.net',
			}),
		).toBe('789@s.whatsapp.net')
	})

	test('returns empty string when all fields missing', () => {
		expect(extractSenderJid({})).toBe('')
		expect(extractSenderJid({ participant: null, participantAlt: null, remoteJidAlt: null })).toBe('')
	})

	test('handles empty string participantAlt', () => {
		// Empty string is falsy, so it should fall through
		expect(
			extractSenderJid({
				participant: '',
				participantAlt: '',
				remoteJidAlt: '789@s.whatsapp.net',
			}),
		).toBe('789@s.whatsapp.net')
	})

	test('uses participant when it has a value even if alts exist', () => {
		expect(
			extractSenderJid({
				participant: '200abc@lid',
				participantAlt: '628123@s.whatsapp.net',
			}),
		).toBe('200abc@lid')
	})
})

describe('buildBaileysMessageKey', () => {
	test('returns null when id is missing', () => {
		expect(buildBaileysMessageKey({ remoteJid: '120@g.us' })).toBeNull()
	})

	test('returns null when remoteJid is missing/blank', () => {
		expect(buildBaileysMessageKey({ id: 'MSG-1', remoteJid: null })).toBeNull()
		expect(buildBaileysMessageKey({ id: 'MSG-1', remoteJid: '   ' })).toBeNull()
	})

	test('omits participant when null/blank', () => {
		expect(
			buildBaileysMessageKey({
				id: 'MSG-1',
				remoteJid: '120@g.us',
				participant: ' ',
				fromMe: null,
			}),
		).toEqual({
			id: 'MSG-1',
			remoteJid: '120@g.us',
			fromMe: false,
		})
	})

	test('includes participant when present', () => {
		expect(
			buildBaileysMessageKey({
				id: 'MSG-2',
				remoteJid: '120@g.us',
				participant: '628123@s.whatsapp.net',
				fromMe: true,
			}),
		).toEqual({
			id: 'MSG-2',
			remoteJid: '120@g.us',
			participant: '628123@s.whatsapp.net',
			fromMe: true,
		})
	})
})
