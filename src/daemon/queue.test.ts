import { describe, expect, test, vi } from 'bun:test'
import { QuizEngine } from '../quiz/engine.ts'
import type { NMember } from '../types.ts'
import { __runtimeTestInternals } from './runtime.ts'
import type { JobRecord } from './runtime.ts'

const noopSender = {
	sendText: async () => null,
	sendImageWithCaption: async () => null,
	react: async () => {},
}

const dummyMember: NMember = {
	mid: 'm1',
	kananame: 'テスト',
	nickname: 'test',
	classgroup: 'A',
	lid: 'lid1',
}

/** Create a minimal JobRecord for testing queue logic. */
function makeJob(overrides: {
	id: string
	groupId: string
	firstRoundAt: Date | null
	quizDir?: string
	deferred?: boolean
}): JobRecord {
	return {
		id: overrides.id,
		engine: new QuizEngine(noopSender, { onFinished: vi.fn() }),
		meta: {
			sources: [overrides.quizDir ?? `/tmp/${overrides.id}`],
			groupId: overrides.groupId,
			quizDir: overrides.quizDir ?? `/tmp/${overrides.id}`,
			membersFile: null,
			noCooldown: false,
			noSchedule: false,
			noGeneration: false,
			createdAt: new Date(),
			introAt: null,
			firstRoundAt: overrides.firstRoundAt,
		},
		deferred: overrides.deferred ? { quizBundle: null as any, members: [dummyMember], runOptions: undefined } : null,
	}
}

describe('per-group queue ordering', () => {
	test('jobs within same group are sorted by firstRoundAt (earliest first)', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobLate = makeJob({ id: 'j-late', groupId, firstRoundAt: new Date('2026-04-05T12:00:00Z') })
		const jobEarly = makeJob({ id: 'j-early', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		const jobMid = makeJob({ id: 'j-mid', groupId, firstRoundAt: new Date('2026-04-05T11:00:00Z') })

		// Add in non-chronological order
		ctx.jobs.set('j-late', jobLate)
		ctx.jobs.set('j-early', jobEarly)
		ctx.jobs.set('j-mid', jobMid)

		ctx.addToQueue('j-late', groupId)
		ctx.addToQueue('j-early', groupId)
		ctx.addToQueue('j-mid', groupId)

		const queue = ctx.groupQueues.get(groupId)!
		expect(queue).toEqual(['j-early', 'j-mid', 'j-late'])
	})

	test('jobs with null firstRoundAt sort after those with a date', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobNoDate = makeJob({ id: 'j-nodate', groupId, firstRoundAt: null })
		const jobWithDate = makeJob({ id: 'j-dated', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })

		ctx.jobs.set('j-nodate', jobNoDate)
		ctx.jobs.set('j-dated', jobWithDate)

		ctx.addToQueue('j-nodate', groupId)
		ctx.addToQueue('j-dated', groupId)

		const queue = ctx.groupQueues.get(groupId)!
		expect(queue).toEqual(['j-dated', 'j-nodate'])
	})

	test('jobs in different groups have independent queues', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const g1 = 'g1@g.us'
		const g2 = 'g2@g.us'

		const jobG1 = makeJob({ id: 'j-g1', groupId: g1, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		const jobG2 = makeJob({ id: 'j-g2', groupId: g2, firstRoundAt: new Date('2026-04-05T12:00:00Z') })

		ctx.jobs.set('j-g1', jobG1)
		ctx.jobs.set('j-g2', jobG2)

		ctx.addToQueue('j-g1', g1)
		ctx.addToQueue('j-g2', g2)

		expect(ctx.groupQueues.get(g1)).toEqual(['j-g1'])
		expect(ctx.groupQueues.get(g2)).toEqual(['j-g2'])
	})

	test('addToQueue returns correct position (0-based)', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobEarly = makeJob({ id: 'j-early', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		const jobLate = makeJob({ id: 'j-late', groupId, firstRoundAt: new Date('2026-04-05T12:00:00Z') })

		ctx.jobs.set('j-early', jobEarly)
		ctx.jobs.set('j-late', jobLate)

		// Add late first → goes to position 0 initially
		const pos1 = ctx.addToQueue('j-late', groupId)
		expect(pos1).toBe(0)

		// Add early → should sort before late, early at 0, late at 1
		const pos2 = ctx.addToQueue('j-early', groupId)
		expect(pos2).toBe(0)

		expect(ctx.groupQueues.get(groupId)).toEqual(['j-early', 'j-late'])
	})
})

describe('active job vs deferred jobs', () => {
	test('only first queued job is active; later jobs remain deferred', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobFirst = makeJob({ id: 'j-first', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })
		const jobSecond = makeJob({
			id: 'j-second',
			groupId,
			firstRoundAt: new Date('2026-04-05T11:00:00Z'),
			deferred: true,
		})

		ctx.jobs.set('j-first', jobFirst)
		ctx.jobs.set('j-second', jobSecond)

		ctx.addToQueue('j-first', groupId)
		ctx.addToQueue('j-second', groupId)

		// Advance to start the first job (consumes its deferred payload)
		ctx.advanceQueue(groupId)

		// First job should have its deferred consumed
		expect(ctx.jobs.get('j-first')!.deferred).toBeNull()
		// Second job should still be deferred
		expect(ctx.jobs.get('j-second')!.deferred).not.toBeNull()
	})

	test('isActiveJob returns true only for first-in-queue', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobFirst = makeJob({ id: 'j-first', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		const jobSecond = makeJob({ id: 'j-second', groupId, firstRoundAt: new Date('2026-04-05T11:00:00Z') })

		ctx.jobs.set('j-first', jobFirst)
		ctx.jobs.set('j-second', jobSecond)

		ctx.addToQueue('j-first', groupId)
		ctx.addToQueue('j-second', groupId)

		expect(ctx.isActiveJob('j-first', groupId)).toBe(true)
		expect(ctx.isActiveJob('j-second', groupId)).toBe(false)
	})

	test('getActiveJobIdForGroup returns first job ID', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		expect(ctx.getActiveJobIdForGroup(groupId)).toBeUndefined()

		const job = makeJob({ id: 'j1', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		ctx.jobs.set('j1', job)
		ctx.addToQueue('j1', groupId)

		expect(ctx.getActiveJobIdForGroup(groupId)).toBe('j1')
	})
})

describe('finishJob triggers advanceQueue', () => {
	test('when active job finishes, next queued job starts automatically', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobFirst = makeJob({ id: 'j-first', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })
		const jobSecond = makeJob({
			id: 'j-second',
			groupId,
			firstRoundAt: new Date('2026-04-05T11:00:00Z'),
			deferred: true,
		})

		ctx.jobs.set('j-first', jobFirst)
		ctx.jobs.set('j-second', jobSecond)

		ctx.addToQueue('j-first', groupId)
		ctx.addToQueue('j-second', groupId)

		// Start first job
		ctx.advanceQueue(groupId)
		expect(ctx.jobs.get('j-first')!.deferred).toBeNull()
		expect(ctx.jobs.get('j-second')!.deferred).not.toBeNull()

		// Finish first job — should trigger advanceQueue
		ctx.finishJob('j-first')

		// First job should be removed
		expect(ctx.jobs.has('j-first')).toBe(false)

		// Second job should now be active (deferred consumed)
		expect(ctx.jobs.get('j-second')!.deferred).toBeNull()

		// Queue should now have only the second job
		expect(ctx.groupQueues.get(groupId)).toEqual(['j-second'])
	})

	test('finishing the last job in a group empties the queue', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job = makeJob({ id: 'j1', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })
		ctx.jobs.set('j1', job)
		ctx.addToQueue('j1', groupId)

		ctx.finishJob('j1')

		expect(ctx.jobs.has('j1')).toBe(false)
		expect(ctx.groupQueues.has(groupId)).toBe(false)
	})

	test('finishing a non-existent job is a no-op', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		// Should not throw
		ctx.finishJob('nonexistent')
		expect(ctx.jobs.size).toBe(0)
	})

	test('cascading advancement: finishing a job triggers next, which triggers next', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const jobs = [
			makeJob({ id: 'j-1', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true }),
			makeJob({ id: 'j-2', groupId, firstRoundAt: new Date('2026-04-05T11:00:00Z'), deferred: true }),
			makeJob({ id: 'j-3', groupId, firstRoundAt: new Date('2026-04-05T12:00:00Z'), deferred: true }),
		]

		for (const job of jobs) {
			ctx.jobs.set(job.id, job)
			ctx.addToQueue(job.id, groupId)
		}

		// Start first
		ctx.advanceQueue(groupId)
		expect(ctx.jobs.get('j-1')!.deferred).toBeNull()

		// Finish first → second starts
		ctx.finishJob('j-1')
		expect(ctx.jobs.has('j-1')).toBe(false)
		expect(ctx.jobs.get('j-2')!.deferred).toBeNull()
		expect(ctx.jobs.get('j-3')!.deferred).not.toBeNull()

		// Finish second → third starts
		ctx.finishJob('j-2')
		expect(ctx.jobs.has('j-2')).toBe(false)
		expect(ctx.jobs.get('j-3')!.deferred).toBeNull()

		// Finish third → queue empty
		ctx.finishJob('j-3')
		expect(ctx.jobs.has('j-3')).toBe(false)
		expect(ctx.groupQueues.has(groupId)).toBe(false)
	})
})

describe('quiz-status reflects queue positions', () => {
	test('getJobStatus includes queuePosition for queued jobs', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job1 = makeJob({ id: 'j-pos0', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })
		const job2 = makeJob({ id: 'j-pos1', groupId, firstRoundAt: new Date('2026-04-05T11:00:00Z'), deferred: true })

		ctx.jobs.set('j-pos0', job1)
		ctx.jobs.set('j-pos1', job2)

		ctx.addToQueue('j-pos0', groupId)
		ctx.addToQueue('j-pos1', groupId)

		// Start first job so it shows as running
		ctx.advanceQueue(groupId)

		const statuses = ctx.getJobStatus()
		expect(statuses).toHaveLength(2)

		const status0 = statuses.find((s) => s.id === 'j-pos0')!
		const status1 = statuses.find((s) => s.id === 'j-pos1')!

		expect(status0.queuePosition).toBe(0)
		expect(status0.status).toBe('running')

		expect(status1.queuePosition).toBe(1)
		expect(status1.status).toBe('scheduled')
	})

	test('getJobStatus does not include queuePosition for removed jobs', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job = makeJob({ id: 'j-removed', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		ctx.jobs.set('j-removed', job)

		// Job exists but is NOT in any queue
		const statuses = ctx.getJobStatus()
		expect(statuses).toHaveLength(1)
		expect(statuses[0]!.queuePosition).toBeUndefined()
	})

	test('empty context returns empty status array', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		expect(ctx.getJobStatus()).toEqual([])
	})

	test('status includes quizDir and noCooldown from job meta', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job = makeJob({ id: 'j-meta', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		ctx.jobs.set('j-meta', job)
		ctx.addToQueue('j-meta', groupId)

		const statuses = ctx.getJobStatus()
		expect(statuses[0]!.quizDir).toBe('/tmp/j-meta')
		expect(statuses[0]!.noCooldown).toBe(false)
		expect(statuses[0]!.groupId).toBe(groupId)
	})
})

describe('clearGroupQueue (season-stop behavior)', () => {
	test('clearGroupQueue removes all jobs and empties the group queue', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job1 = makeJob({ id: 'j-a', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })
		const job2 = makeJob({ id: 'j-b', groupId, firstRoundAt: new Date('2026-04-05T11:00:00Z'), deferred: true })
		const job3 = makeJob({ id: 'j-c', groupId, firstRoundAt: new Date('2026-04-05T12:00:00Z'), deferred: true })

		ctx.jobs.set('j-a', job1)
		ctx.jobs.set('j-b', job2)
		ctx.jobs.set('j-c', job3)

		ctx.addToQueue('j-a', groupId)
		ctx.addToQueue('j-b', groupId)
		ctx.addToQueue('j-c', groupId)

		// Start first job
		ctx.advanceQueue(groupId)

		// Clear entire group (simulates season-stop)
		ctx.clearGroupQueue(groupId)

		expect(ctx.jobs.size).toBe(0)
		expect(ctx.groupQueues.has(groupId)).toBe(false)
		expect(ctx.getJobStatus()).toHaveLength(0)
	})

	test('clearGroupQueue does not affect jobs in other groups', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const g1 = 'g1@g.us'
		const g2 = 'g2@g.us'

		const jobG1 = makeJob({ id: 'j-g1', groupId: g1, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })
		const jobG2 = makeJob({ id: 'j-g2', groupId: g2, firstRoundAt: new Date('2026-04-05T10:00:00Z'), deferred: true })

		ctx.jobs.set('j-g1', jobG1)
		ctx.jobs.set('j-g2', jobG2)

		ctx.addToQueue('j-g1', g1)
		ctx.addToQueue('j-g2', g2)

		// Clear group g1 only
		ctx.clearGroupQueue(g1)

		expect(ctx.jobs.has('j-g1')).toBe(false)
		expect(ctx.jobs.has('j-g2')).toBe(true)
		expect(ctx.groupQueues.has(g1)).toBe(false)
		expect(ctx.groupQueues.has(g2)).toBe(true)
	})

	test('clearGroupQueue on non-existent group is a no-op', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		// Should not throw
		ctx.clearGroupQueue('nonexistent@g.us')
		expect(ctx.jobs.size).toBe(0)
	})

	test('clearGroupQueue then adding new job to same group works', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const oldJob = makeJob({ id: 'j-old', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		ctx.jobs.set('j-old', oldJob)
		ctx.addToQueue('j-old', groupId)

		// Clear
		ctx.clearGroupQueue(groupId)

		// Add new job to same group
		const newJob = makeJob({ id: 'j-new', groupId, firstRoundAt: new Date('2026-04-05T14:00:00Z') })
		ctx.jobs.set('j-new', newJob)
		const pos = ctx.addToQueue('j-new', groupId)

		expect(pos).toBe(0)
		expect(ctx.groupQueues.get(groupId)).toEqual(['j-new'])
	})
})

describe('removeFromQueue edge cases', () => {
	test('removing a job that is not in the queue is a no-op', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job = makeJob({ id: 'j1', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		ctx.jobs.set('j1', job)
		ctx.addToQueue('j1', groupId)

		// Remove a non-existent job ID
		ctx.removeFromQueue('nonexistent', groupId)

		expect(ctx.groupQueues.get(groupId)).toEqual(['j1'])
	})

	test('removing the only job in a queue deletes the queue entry', () => {
		const ctx = __runtimeTestInternals.createQueueTestContext()
		const groupId = 'g1@g.us'

		const job = makeJob({ id: 'j1', groupId, firstRoundAt: new Date('2026-04-05T10:00:00Z') })
		ctx.jobs.set('j1', job)
		ctx.addToQueue('j1', groupId)

		expect(ctx.groupQueues.has(groupId)).toBe(true)
		ctx.removeFromQueue('j1', groupId)
		expect(ctx.groupQueues.has(groupId)).toBe(false)
	})
})
