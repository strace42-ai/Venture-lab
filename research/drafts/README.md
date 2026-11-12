# research/drafts — unapproved research drafts

Files here are **AI or researcher drafts** (`"source": "ai-draft"`). They are never applied to the database:
`research:import --apply` refuses any file in this folder and any `ai-draft` envelope.

Workflow: `npm run research:draft-check -- research/drafts/<file>.json` → the founder checks every source and
Russian competitor → sets `"source": "human-reviewed"`, adds `approval`, moves the file to `research/inbox/` →
`research:import` dry-run → `--apply`. Per-source `checked` is set afterwards with `npm run research:review`.
See `docs/research-export-guide.md`.
