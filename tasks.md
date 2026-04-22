# Prerequisites

When you've finished all tasks, execute `agent-sleep` CLI (no argument) on your own, re-check this file in case new items were added. Repeat until no task has been added.

Don't forget to git commit regularly.

## Implement now (ignore any task if already implemented and tested).

- Looks to me that you messed up with SurrealDB schema (also I've fixed your mistaken IF NOT EXISTS which should be put after DEFINE FIELD/TABLE):
  ⚡ warning kotaete·plugin·ask ask: memory save failed: Found field 'messages[0].content', but no such field exists for table 'kotaete_ask_memory'
  ⚡ warning kotaete·plugin·ask ask: memory save failed: Found field 'messages[0].content', but no such field exists for table 'kotaete_ask_memory'
