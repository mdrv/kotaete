export type QuizTunables = {
	timeout: {
		/** Normal question timeout in ms */
		normalMs: number
		/** Special/god stage question timeout in ms */
		specialMs: number
		/** How far before deadline to send the warning message (ms) */
		warningLeadMs: number
		/** Delay before sending the god-stage question after announcement (ms) */
		godAnnounceDelayMs: number
	}
	cooldown: {
		/** Cooldown duration in ms after a correct answer */
		ms: number
	}
	points: {
		/** Points awarded per wrong answer (normal stage only) */
		perWrong: number
		/** Maximum total points for a correct answer in normal stage */
		normalCap: number
		/** Fixed points for a correct answer in special/god stage */
		special: number
	}
	wrongAttempts: {
		/** Max wrong answers per player per normal question */
		maxAttempts: number
		/** Max wrong answers per player per god/special question */
		specialMaxAttempts: number
		/** Emojis for each wrong answer (index 0 = first wrong, etc.) */
		emojiStreak: ReadonlyArray<string>
	}
}

export type QuizTunablesInput = Partial<{
	timeout: Partial<QuizTunables['timeout']>
	cooldown: Partial<QuizTunables['cooldown']>
	points: Partial<QuizTunables['points']>
	wrongAttempts: Partial<QuizTunables['wrongAttempts']>
}>

export type NMember = {
	mid: string
	kananame: string
	nickname: string
	classgroup: string
	lid: string
	pn?: string
}

export type QuizQuestion = {
	number: number
	text: string
	answers: ReadonlyArray<string>
	kanjiAnswers?: ReadonlyArray<string>
	extraPts?: number
	answerExtraPts?: ReadonlyMap<string, number>
	extraHint?: string
	explanation: string
	imagePath: string | null
	isSpecialStage: boolean
}

export type QuizRound = {
	emoji: string
	startAt: Date
	questions: ReadonlyArray<QuizQuestion>
}

export type QuizMessageTemplates = {
	introHeader: string
	introRoundLine: string
	godStageAnnouncement: string
	nextRoundNotice: string
	questionFooter: string
	cooldownWarning: string
	questionCooldown: string
	questionWarning: string
	timeout: string
	winner: string
	winnerPerfect: string
	romajiTease: string
	explanation: string
	explanationSpecial: string
	breakHeader: string
	finalHeader: string
	finalRow: string
	finalEmpty: string
	finalFooterDefault: string
	intro?: string
	outro?: string
}

export type QuizBundle = {
	directory: string
	sources?: ReadonlyArray<string>
	introAt: Date
	startAt: Date
	rounds: ReadonlyArray<QuizRound>
	introNote: string | null
	outroNote: string | null
	messageTemplates: Partial<QuizMessageTemplates>
	questions: ReadonlyArray<QuizQuestion>
	groupId?: string | null
	members?: ReadonlyArray<NMember> | null
	membersFile?: string | null
	season?: SeasonConfig | null
	tunables: QuizTunables
}

export type ConfigQuestionImage = {
	credit: string
	jp: string
	romaji: string
	god?: boolean
}

export type ConfigAnswerEntry = string | string[] | { text: string | string[]; extraPts?: number }

export type ConfigQuestionAnswers = {
	kana?: ConfigAnswerEntry
	romaji?: ConfigAnswerEntry
	kanji?: ConfigAnswerEntry
}

export type ConfigQuestion = {
	no: number
	hint: string
	answers: ConfigQuestionAnswers
	extraHint?: string
	explanation?: string
	image?: ConfigQuestionImage
}

export type QuizImageTemplateConfig = {
	default?: string
	god?: string
}

export type QuizScheduleConfig = {
	intro: Date | null
	start: Date | null
	rounds: ReadonlyArray<{
		emoji: string
		start: Date
		questionRange: readonly [number, number]
		godStage: number | null
	}>
	messages: Partial<QuizMessageTemplates>
	questions: ReadonlyArray<ConfigQuestion>
	groupId: string | null
	members: ReadonlyArray<NMember> | string | null
	imageTemplates: QuizImageTemplateConfig
	season?: SeasonConfig | null
	tunables: QuizTunables
}

export type QuizScheduleConfigInput = {
	intro?: Date | string | number
	start?: Date | string | number
	rounds?: ReadonlyArray<{
		emoji?: string
		start: Date | string | number
		questionRange: readonly [number, number]
		godStage?: number | null
	}>
	messages?: Partial<QuizMessageTemplates>
	questions?: ReadonlyArray<ConfigQuestion>
	groupId?: string
	members?: ReadonlyArray<NMember> | string
	imageTemplates?: QuizImageTemplateConfig
	templates?: QuizImageTemplateConfig
	template?: string
	templateGod?: string
	season?: SeasonConfig
	tunables?: QuizTunablesInput
}

export type MessageKeyLike = {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
	fromMe?: boolean | null
}

export type IncomingMedia = {
	type: 'image'
	mimeType: string
	base64: string
}

export type IncomingGroupMessage = {
	groupId: string
	senderRawJid: string
	senderNumber: string | null
	senderLid: string | null
	text: string
	key: MessageKeyLike
	media: IncomingMedia | null
	mentionedJids: string[]
}

export type IncomingDmMessage = {
	senderJid: string
	senderNumber: string | null
	senderLid: string | null
	text: string
	key: MessageKeyLike
	media: IncomingMedia | null
	mentionedJids: string[]
}

export type SeasonConfig = {
	start?: boolean
	end?: boolean
	caption?: string
	scoreboardTemplate?: string
	id?: string
}

export type QuizRunPayload = {
	sources: ReadonlyArray<string>
	quizDir?: string
	groupId?: string
	membersFile?: string
	noCooldown?: boolean
	noSchedule?: boolean
	noGeneration?: boolean
	saveSvg?: boolean
	season?: SeasonConfig
}
