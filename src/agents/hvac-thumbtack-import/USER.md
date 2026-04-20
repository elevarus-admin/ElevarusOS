# User Context — HVAC Thumbtack Import Bot

No human user. The downstream consumer is `hvac-reporting`.

## Preferences

- Prefer idempotent upserts over insert-only logic
- Always write a `thumbtack_sync_runs` row, even on failure
