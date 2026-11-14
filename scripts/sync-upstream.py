#!/usr/bin/env python3
"""Re-vendor the pi-vcc core from an upstream checkout.

WHY THIS EXISTS
---------------
The compiler and recall core under src/core/ and src/extract/ is upstream
pi-vcc source, not a rewrite. Keeping that true across upstream releases needs
a mechanical, reviewable copy step instead of hand edits: this script copies
the vendored file set, applies the two documented mechanical changes, and
applies the two seam changes the DSH glue requires.

Usage:
  scripts/sync-upstream.py --upstream /path/to/pi-vcc

The upstream checkout must be at the commit recorded in NOTICE. After running,
build and run the suite:

  npx tsc -p tsconfig.json && node --test tests/upstream/*.test.ts tests/dsh/*.test.ts
"""

import argparse
import re
import sys
from pathlib import Path

# Files copied verbatim from upstream (module specifiers and the settings path
# are the only edits).
VENDORED = [
    "src/types.ts",
    "src/sections.ts",
    "src/core/brief.ts",
    "src/core/build-sections.ts",
    "src/core/compact-args.ts",
    "src/core/content.ts",
    "src/core/filter-noise.ts",
    "src/core/format-recall.ts",
    "src/core/format.ts",
    "src/core/global-indices.ts",
    "src/core/jsonl.ts",
    "src/core/lineage.ts",
    "src/core/load-messages.ts",
    "src/core/normalize.ts",
    "src/core/rank.ts",
    "src/core/recall-request.ts",
    "src/core/recall-run.ts",
    "src/core/recall-scope.ts",
    "src/core/render-entries.ts",
    "src/core/report.ts",
    "src/core/sanitize.ts",
    "src/core/search-entries.ts",
    "src/core/settings.ts",
    "src/core/skill-collapse.ts",
    "src/core/summarize.ts",
    "src/core/token-estimate.ts",
    "src/core/tool-args.ts",
    "src/core/drill-down.ts",
    "src/extract/commits.ts",
    "src/extract/files.ts",
    "src/extract/tracked-commands.ts",
    "src/extract/user-messages.ts",
]

IMPORT_RE = re.compile(r'from (["\'])(\.[^"\']*)\1')


def rewrite_imports(text: str) -> str:
    def repl(match):
        quote, spec = match.group(1), match.group(2)
        if re.search(r"\.(js|ts|json|mjs|cjs)$", spec):
            return match.group(0)
        return f"from {quote}{spec}.ts{quote}"

    return IMPORT_RE.sub(repl, text)


def apply_settings_path(text: str) -> str:
    text = text.replace(
        'import { getAgentDir } from "@earendil-works/pi-coding-agent";',
        'import { homedir } from "os";',
    )
    text = text.replace(
        'export const SETTINGS_PATH_DEFAULT = join(getAgentDir(), "pi-vcc-config.json");',
        'export const SETTINGS_PATH_DEFAULT = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-vcc-config.json");',
    )
    return text.replace(
        'process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT',
        'process.env.DSH_VCC_CONFIG_PATH ?? process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT',
    )


def apply_drill_down_seam(text: str) -> str:
    text = text.replace(
        'import { loadAllMessages } from "./load-messages.ts";',
        'import type { LoadedMessages } from "./load-messages.ts";',
    )
    text = text.replace(
        """export function expandEntryFile(
  sessionFile: string,
  entryIndex: number,
  pathPattern: string,
  full = false,
  offset?: number,
  limit?: number,
): string {
  const { rendered, rawMessages } = loadAllMessages(sessionFile, true);""",
        """export function expandEntryFile(
  loaded: LoadedMessages,
  entryIndex: number,
  pathPattern: string,
  full = false,
  offset?: number,
  limit?: number,
): string {
  // dsh: the caller supplies the loaded message pool (the pi version re-read
  // the session file here); everything below is upstream logic.
  const { rendered, rawMessages } = loaded;""",
    )
    return text


def apply_recall_run_seam(text: str) -> str:
    text = text.replace(
        'import { loadAllMessages, type LoadedMessages } from "./load-messages.ts";',
        'import type { LoadedMessages } from "./load-messages.ts";',
    )
    text = text.replace(
        'import { getActiveLineageEntryIds, type LineageSessionManagerLike } from "./lineage.ts";',
        "",
    )
    text = text.replace(
        "expandEntryFile(view.sessionFile, t.index, t.pathPattern, t.full, t.offset, t.limit)",
        "expandEntryFile(view.load(true), t.index, t.pathPattern, t.full, t.offset, t.limit)",
    )
    start = text.index("export const openRecallView =")
    marker = " * When the current conversation path has nothing for a query, range or"
    end = text.rindex("/**", 0, text.index(marker))
    note = (
        "// dsh: upstream's file-based view factory (openRecallView/findCurrentTurn) is\n"
        "// replaced by src/dsh/recall-view.ts, which builds the same RecallView from\n"
        "// dsh session events. `view.load(full)` and `view.widen()` are the whole seam\n"
        "// the recall actions below use.\n\n"
    )
    return text[:start] + note + text[end:]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True, help="pi-vcc checkout at the NOTICE commit")
    parser.add_argument("--repo", default=Path(__file__).resolve().parent.parent, type=Path)
    args = parser.parse_args()

    upstream = Path(args.upstream)
    repo = args.repo
    if not (upstream / "src/core/summarize.ts").exists():
        print(f"sync-upstream: {upstream} does not look like a pi-vcc checkout", file=sys.stderr)
        return 1

    for rel in VENDORED:
        text = (upstream / rel).read_text()
        text = rewrite_imports(text)
        if rel == "src/core/settings.ts":
            text = apply_settings_path(text)
        if rel == "src/core/drill-down.ts":
            text = apply_drill_down_seam(text)
        if rel == "src/core/recall-run.ts":
            text = apply_recall_run_seam(text)
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        print(f"vendored {rel}")
    print(f"sync-upstream: {len(VENDORED)} files from {upstream}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())