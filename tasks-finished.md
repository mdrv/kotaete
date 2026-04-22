Note: Don't mind this note; it's just for history purpose.

- Got this warning:
  ⚡ warning kotaete·plugin·ask ask: memory save failed: Couldn't coerce value for field `created_at` of `kotaete_ask_memory:jnjs28wqqmcdz66pjq9y`: Expected `datetime`
  but found `'2026-04-22T03:38:09.563Z'`
  ⚡ warning kotaete·plugin·ask ask: memory save failed: Couldn't coerce value for field `created_at` of `kotaete_ask_memory:q59iqxzizqmdg8xg7jw2`: Expected `datetime`
  but found `'2026-04-22T03:38:12.893Z'`
- Regarding `ask` plugin limit reset, should accept cron syntax (default: `0,30 * * * *` meaning every 30 minutes). Also change rate limit message: "Hai, <nickname>, tunggu pukul 16.00 WIB biar Bearcu bisa jawab lagi, ya!"
- On kotaete `ask` plugin, add auto-compact memory via SurrealDB (table: `kotaete_ask_memory`).
- Currently, `ask` plugin bot thinks markdown syntax is viable, but in WhatsApp it's very limited + different (** for bold, __ for italic). No table/link with caption support as well.
- On group, the message should have bot ID mentioned (@Bearcu / @<its lid>) rather than `/ask` prefix. `/ask` prefix can be used for personal message (one-on-one) instead.
- There should be two reactions (defining steps): 💭 before responding, then ✅ after responding.
