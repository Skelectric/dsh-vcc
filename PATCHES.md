# Local diffs against upstream pi-vcc

Upstream: `sting8k/pi-vcc` v0.11.2, commit `2da84918b90100c4cda0a1d468e42375c7253d61`.

Everything under `src/core/` and `src/extract/` is upstream source. The only
changes are mechanical, and `scripts/sync-upstream.py` reproduces them:

1. **Explicit import extensions.** Upstream is bundled by Bun, which resolves
   extensionless specifiers; Node ESM requires them. Every relative import
   gains an explicit `.ts` extension (`"./content"` -> `"./content.ts"`), so the
   package ships as TypeScript source and Node's type stripping runs it with no
   build step.
2. **Settings path.** `src/core/settings.ts` resolves its config file from
   `$DSH_HOME/dsh-vcc-config.json` (or `$DSH_VCC_CONFIG_PATH`) instead of
   `getAgentDir()` from `@earendil-works/pi-coding-agent`.
3. **Drill-down seam.** `expandEntryFile` takes the loaded message pool
   (`LoadedMessages`) instead of a session-file path, because DSH has no
   session JSONL file to re-read.
4. **Recall view seam.** `openRecallView`/`findCurrentTurn` (pi's session file +
   branch manager) are removed from `recall-run.ts`; `src/dsh/recall-view.ts`
   supplies the same `RecallView` over DSH session events. The drill action
   passes `view.load(true)` to `expandEntryFile`.

Upstream modules that this port replaces are not vendored; their dsh
equivalents live in `src/dsh/`. `load-messages` (session-file JSONL) is
replaced by a dsh session-event loader, and the pi hook/tool/command layers by
the dsh engine, tool, and command registrations.

`scripts/sync-upstream.py --upstream <checkout>` reproduces all four changes
and re-vendors the file set, so an upstream bump is a reviewable diff.

`tests/upstream/` holds upstream's test suite for the vendored core, unmodified
except for the `bun:test` import (a Node shim lives in `tests/bun-test.js`) and
module specifiers. Tests that exercise the pi hook, tool registration, or pi
type validation are not vendored: they import `src/hooks/before-compact.ts`
and `src/tools/recall.ts`, pi-only modules this port does not include, so they
remain upstream-only at the pi-vcc commit recorded in NOTICE.
