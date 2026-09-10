---
description: Sync local AI usage totals to the usage dashboard (no repo needed)
---

Sync this machine's AI coding usage to the usage dashboard using the published collector package. No repository checkout is required.

Run (Bun preferred, Node 22+ also works):

```
bunx ai-usage-collector@latest --push --days $ARGUMENTS
```

If `$ARGUMENTS` is empty, use `--days 30`.

Rules:
- Required env vars: `API_URL`, `INGEST_TOKEN`. Optional: `DEVICE_ID`, `DEVICE_LABEL` (default to the hostname), `SKIP_PROVIDERS` (e.g. `opencode` when cloud-synced).
- If `API_URL` or `INGEST_TOKEN` is missing, STOP and tell the user exactly which variable to set and where — do not guess values.
- Never print secret values, tokens, file paths, prompts, or completions. Only report the per-provider stats lines and the final `{ok, pushedDays}` line.
- On failure, report the error line verbatim and suggest retrying; the collector is idempotent.
