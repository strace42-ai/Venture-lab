# Instructions for Claude Code — Venture Lab

Read in this order:
1. `tasks/current-task.md` (current authorized scope).
2. `docs/product-vision.md` and `docs/design-principles.md`.
3. `docs/scoring-model.md`, `docs/data-contracts.md`, and `docs/agent-workflow.md` when relevant.

**Current mode:** implement the first UI foundation. Repository documents are requirements, not proof the features exist.

## Execution protocol
- Inspect the repo before edits; record branch and HEAD SHA.
- Work in a NEW `claude/...` branch from `main`. Do not directly push to main.
- Treat `tasks/current-task.md` as the task contract; if another file conflicts, document it, prefer that scope, and avoid speculative scope growth.
- Work incrementally, do not implement unrequested APIs/auth/paid services.
- Use React + TypeScript and strictly typed mock data. No fabricated source claims, financial performance or pretend live data.
- Implement accessible, responsive UI with keyboard/focus states, empty/loading/error states where relevant.
- Run real install/build/lint/tests as available. Mark checks **not run** if not performed.
- Update `handoff/latest.md` with changes, actual checks, known limitations, PR/branch/commit and next recommendation.
- Commit, push and open a PR to main; never merge without founder approval.
- Avoid secrets, .env values, paid APIs, deployment or external mutations unless separately authorized.
- For dangerous or irreversible actions request approval.

## Output
Tell the founder only the PR link, concise summary, checks performed and key unresolved risks. Full detail lives in the PR and handoff file.
