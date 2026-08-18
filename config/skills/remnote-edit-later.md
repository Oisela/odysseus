# RemNote Edit-Later workflow contract

This is the durable source for the published `remnote-edit-later` skill. Keep
the live skill aligned with this contract.

## Evidence first

1. Call `remnote_status` once. Stop if the plugin is disconnected.
2. Resolve Edit Later with `inspect_powerup_registry`; use
   `powerups.e.remId` and verify its localized title.
3. Never copy a sample ID or count from a prompt, skill example, screenshot,
   memory, or earlier chat. Do not report a count before the tool returns it.
4. Call `list_tagged_rems` with `tagRemId`, not `tagId`, only as a normal-tag
   probe. Preserve the returned rows as the working list when they are valid.

## Built-in powerup safeguard

Edit Later is a built-in powerup, not necessarily a normal Rem tag. The RemNote
SDK can resolve its localized Rem while the normal tag relation still returns
zero. A zero from `list_tagged_rems` is not sufficient evidence that the
Edit-Later inbox is empty.

When the result is zero:

- If the user or RemNote UI reports a non-zero count, report the mismatch and
  do not call the inbox empty. Do not remove tags or mutate Rems.
- Use a bridge action explicitly documented to enumerate Rems by active
  built-in powerup, if one is exposed. Do not guess action names and do not use
  LevelDB heuristics as authoritative data.
- If no such action is available, state that enumeration is blocked by the
  bridge capability. Record the verified registry title/ID and both observed
  counts. A skill-only change can prevent the false claim but cannot invent the
  missing rows.
- Only call an inbox empty when the authoritative built-in-powerup query (or
  RemNote UI itself) reports zero and no contradictory evidence exists.

## Review loop

After a trustworthy list is available, show its count and numbered titles and
ask whether to process all or selected Rems. Read and handle one Rem at a time.
Preserve clozes and rich text, ask before destructive changes, remove the
powerup only after the Rem is complete, and verify every write by reading it
back. At the end, re-query authoritatively and assign every original item one
status: processed, skipped, or open.
