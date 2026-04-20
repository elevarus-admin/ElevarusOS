# Memory — HVAC Thumbtack Import Bot

## Workflow Notes

- Source sheet is updated daily by Thumbtack
- Upsert key is `(source, day)` — re-imports overwrite cleanly
- `source` is hardcoded to `'hvac'` for the only feed today
- Sheet date is the source of truth; never write `today` blindly

## Common Patterns

_(Empty)_
