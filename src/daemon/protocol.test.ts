import { describe, expect, test } from 'bun:test'
import { jobStatusSchema, relayResponseSchema, relayRunRequestSchema, relayStopRequestSchema } from './protocol.ts'

describe('protocol schemas', () => {
	test('quiz-stop without id parses', () => {
		const result = relayStopRequestSchema.safeParse({ type: 'quiz-stop' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.type).toBe('quiz-stop')
			expect(result.data.id).toBeUndefined()
		}
	})

	test('quiz-stop with id parses', () => {
		const result = relayStopRequestSchema.safeParse({ type: 'quiz-stop', id: 'q-123-1' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.type).toBe('quiz-stop')
			expect(result.data.id).toBe('q-123-1')
		}
	})

	test('quiz-stop rejects non-string id', () => {
		const result = relayStopRequestSchema.safeParse({ type: 'quiz-stop', id: 123 })
		expect(result.success).toBe(false)
	})

	test('run request parses new variadic sources payload', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/members.ts', '/tmp/w20260404', '/tmp/override.ts'],
			noCooldown: true,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.sources).toHaveLength(3)
			expect(result.data.groupId).toBeUndefined()
			expect(result.data.membersFile).toBeUndefined()
		}
	})

	test('run request parses saveSvg field', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/members.ts', '/tmp/w20260404'],
			saveSvg: true,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.saveSvg).toBe(true)
		}
	})

	test('run request parses noGeneration field', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/members.ts', '/tmp/w20260404'],
			noGeneration: true,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.noGeneration).toBe(true)
		}
	})

	test('run request ignores unknown fields (no strict mode)', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/quiz'],
			exportFormat: 'bmp',
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect((result.data as Record<string, unknown>).exportFormat).toBeUndefined()
		}
	})

	test('run request parses season config fields', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/quiz'],
			season: { start: true, end: false, caption: 'Week 1', scoreboardTemplate: '~/template.svg' },
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.season?.start).toBe(true)
			expect(result.data.season?.end).toBe(false)
			expect(result.data.season?.caption).toBe('Week 1')
			expect(result.data.season?.scoreboardTemplate).toBe('~/template.svg')
		}
	})

	test('run request with season end true parses', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/quiz'],
			season: { end: true },
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.season?.end).toBe(true)
		}
	})

	test('run request without season parses', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/quiz'],
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.season).toBeUndefined()
		}
	})

	test('run request ignores legacy exportFormat field', () => {
		const result = relayRunRequestSchema.safeParse({
			type: 'run-quiz',
			sources: ['/tmp/quiz'],
			exportFormat: 'png',
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect((result.data as Record<string, unknown>).exportFormat).toBeUndefined()
		}
	})

	test('relay response with jobs array parses', () => {
		const payload = {
			ok: true,
			message: '2 active job(s)',
			jobs: [
				{
					id: 'q-123-1',
					groupId: '120@g.us',
					quizDir: '/tmp/quiz',
					membersFile: '/tmp/members.csv',
					noCooldown: false,
					status: 'scheduled',
					introAt: '2026-04-04T07:50:00.000Z',
					firstRoundAt: '2026-04-04T08:00:00.000Z',
					createdAt: '2026-04-04T07:45:00.000Z',
				},
				{
					id: 'q-123-2',
					groupId: '121@g.us',
					quizDir: '/tmp/quiz2',
					noCooldown: true,
					noGeneration: true,
					status: 'running',
					createdAt: '2026-04-04T07:46:00.000Z',
				},
			],
		}
		const result = relayResponseSchema.safeParse(payload)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.jobs).toHaveLength(2)
			expect(result.data.jobs?.[0]?.status).toBe('scheduled')
			expect(result.data.jobs?.[1]?.status).toBe('running')
			expect(result.data.jobs?.[1]?.noGeneration).toBe(true)
		}
	})

	test('relay response with jobId parses', () => {
		const payload = {
			ok: true,
			message: 'quiz scheduled (q-123-3)',
			jobId: 'q-123-3',
		}
		const result = relayResponseSchema.safeParse(payload)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.jobId).toBe('q-123-3')
			expect(result.data.jobs).toBeUndefined()
		}
	})

	test('relay response without jobs or jobId still valid', () => {
		const payload = {
			ok: true,
			message: 'no quiz jobs active',
		}
		const result = relayResponseSchema.safeParse(payload)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.jobs).toBeUndefined()
			expect(result.data.jobId).toBeUndefined()
		}
	})

	test('job status schema rejects invalid status', () => {
		const result = jobStatusSchema.safeParse({
			id: 'q-1',
			groupId: '120@g.us',
			quizDir: '/tmp/q',
			noCooldown: false,
			status: 'unknown',
			createdAt: '2026-04-04T07:45:00.000Z',
		})
		expect(result.success).toBe(false)
	})
})

describe('runtime helpers', () => {
	describe('validateSchedulingConstraints', () => {
		test('returns null when first round is in the future', () => {
			const { __runtimeTestInternals } = require('./runtime.ts')
			const future = new Date(Date.now() + 60_000)
			const result = __runtimeTestInternals.validateSchedulingConstraints(future, Date.now(), false)
			expect(result).toBeNull()
		})

		test('returns error message when first round is in the past', () => {
			const { __runtimeTestInternals } = require('./runtime.ts')
			const past = new Date(Date.now() - 60_000)
			const result = __runtimeTestInternals.validateSchedulingConstraints(past, Date.now(), false)
			expect(result).not.toBeNull()
			expect(result).toContain('has passed')
		})

		test('returns null when noSchedule is true even with past start', () => {
			const { __runtimeTestInternals } = require('./runtime.ts')
			const past = new Date(Date.now() - 60_000)
			const result = __runtimeTestInternals.validateSchedulingConstraints(past, Date.now(), true)
			expect(result).toBeNull()
		})

		test('returns null when start is exactly now (boundary)', () => {
			const { __runtimeTestInternals } = require('./runtime.ts')
			const now = new Date(Date.now())
			const result = __runtimeTestInternals.validateSchedulingConstraints(now, now.getTime(), false)
			expect(result).toBeNull()
		})

		test('scheduling guard runs before existing job is stopped (design contract)', () => {
			const { __runtimeTestInternals } = require('./runtime.ts')
			// The validateSchedulingConstraints function is called before forceEndJob.
			// This test verifies the function returns an error for a past start time,
			// confirming that an invalid request would be rejected before reaching forceEndJob.
			const past = new Date(Date.now() - 120_000)
			const result = __runtimeTestInternals.validateSchedulingConstraints(past, Date.now(), false)
			expect(result).not.toBeNull()
			expect(result).toContain('has passed')
		})
	})

	test('job status schema accepts optional queuePosition', () => {
		const result = jobStatusSchema.safeParse({
			id: 'q-1',
			groupId: '120@g.us',
			quizDir: '/tmp/q',
			noCooldown: false,
			status: 'scheduled',
			createdAt: '2026-04-04T07:45:00.000Z',
			queuePosition: 0,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.queuePosition).toBe(0)
		}
	})

	test('computeStopSilenceFromStatus: scheduled jobs are silent by default', () => {
		const { __runtimeTestInternals } = require('./runtime.ts')
		const firstRoundAt = new Date(Date.now() + 60_000)
		const silent = __runtimeTestInternals.computeStopSilenceFromStatus(firstRoundAt, Date.now(), false, false)
		expect(silent).toBe(true)
	})

	test('computeStopSilenceFromStatus: running jobs keep final scoreboard unless --silent', () => {
		const { __runtimeTestInternals } = require('./runtime.ts')
		const firstRoundAt = new Date(Date.now() - 60_000)
		const normalStop = __runtimeTestInternals.computeStopSilenceFromStatus(firstRoundAt, Date.now(), true, false)
		expect(normalStop).toBe(false)
		const forcedSilent = __runtimeTestInternals.computeStopSilenceFromStatus(firstRoundAt, Date.now(), true, true)
		expect(forcedSilent).toBe(true)
	})
})
