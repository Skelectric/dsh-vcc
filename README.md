# dsh-vcc

Deterministic, **no-LLM** conversation compaction for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with lossless `(#N)` recall. A port of [pi-vcc](https://github.com/sting8k/pi-vcc) (MIT).

When a session outgrows its context window, the default backend asks the session model to write a summary. That is a second full prefill of the same history plus a decode, so on a cold cache it doubles the work at the moment the machine is already under load. dsh-vcc replaces the summary *engine*, not the compaction machinery: dsh still decides when and what to compact, but the summary is compiled from the transcript by pure text processing.

- **No model call.** Zero prefill, zero decode, no slot in the inference queue, no dependency on a loaded model.
- **Deterministic.** Identical input always produces identical output.
- **Lossless.** The brief keeps `(#N)` references into the session log; `vcc_recall` searches and expands anything compaction dropped.

## Overrides and what dsh keeps

`BasicCompactionEngine` keeps thresholds, region selection, the `maxTokens` shrink gate, retry/overflow recovery, durable session mutation, and the tool-result pruner. dsh-vcc overrides two methods: `summarize()` and `compactNow()`, the second to widen the manual span (see below).

Automatic compaction ports only the summary. dsh chooses the region, so pi-vcc's keep-tail (`buildOwnCut`, smart-keep) is not used; tune the automatic tail with dsh's `retainTokens`.

The manual path is the exception. dsh's `compactNow` selects with `retainTokens: 0`, which would leave the closing assistant reply outside the span and retain it verbatim after the checkpoint. dsh-vcc extends that span through the closing reply when it is a complete step boundary, so the compiled summary quotes the last exchange the same way pi-vcc does. When the last node is an open tool step or a trailing user message, dsh's selection is used unchanged.

The override is the plugin's only reach into dsh internals: it imports `compactSurfaceRegion`/`selectCompactableRange` from `@deepseek-ai/dsh-compaction-basic/src/region.ts` (allowed by that package's `./src/*` export) and calls the parent's private `regionDependencies()` (present at runtime). A dsh release that moves either one fails loudly at boot or on `/compact`, never silently.

## Install

The plugin is a dsh profile dependency plus one preset row. It is not a bundle: a bundle patch would have to restate the whole preset (the patch dialect keys rows by id in a flat map, and preset-internal ids repeat across presets), which forks the preset without an error and drifts on every dsh upgrade.

```bash
# 1. make the plugin resolvable in the profile
dsh plugin --profile <profile> add link:/path/to/dsh-vcc

# 2. in the profile's cordis.patch.yml, inside the preset's compaction group:
#    disable the stock LLM backend and mount dsh-vcc in its place
```

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
- id: dsh-vcc
  name: 'dsh-vcc'
  config:
    auto: true
    thresholdRatio: 0.95
    retainTokens: 25000
    maxTokens: 12000
```

`auto` and the thresholds are dsh's; see *Tuning*. Verify the row mounts — a
preset child that fails to activate is silent at boot and only appears in the
preset roster's `broken` diagnostic. Set `DSH_VCC_MOUNT_MARKER=/tmp/marker`
before boot to have the engine append a line when it mounts.

## Tuning

The two knobs that decide the cost of a compaction are dsh's:

- `thresholdRatio` — fraction of the context window at which pressure compaction fires. `0.95` matches pi-blackhole's `compactAfterRatio`.
- `retainTokens` — the verbatim tail kept after the checkpoint by automatic (pressure) compaction. The post-compaction prompt is `compiled summary + retained tail`, so this is the re-prefill floor. `25000` matches pi-vcc's smart-keep ceiling.

  It does not apply to `/compact`. The manual path compacts through the closing assistant reply (see *What it is not*), so the post-compaction prompt is the compiled summary alone.

`maxTokens` is only the shrink gate; the compiled summary is far smaller (sections are capped, the brief is ranked to a token budget). Lower it only if you want a hard ceiling on the summary.

## Recall

`vcc_recall` is the pi-vcc tool, unchanged: keyword/regex search (5 per page), `range:[from, to]`, `expand:[N]`, `mode:'touched'`, and `#N:path` drill-down. `scope:'all'` also reaches edited or retried branches. One result is capped at 50 KB.

`#N` is the dsh **event seq** — the same number the summary emits in `(#12)`. It is the only index-space change from pi-vcc, which numbers message entries in the session file.

`/vcc` previews the summary the next compaction would write, without mutating anything. `/vcc-recall …` is the tool as a command.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | `DshVccCompactionEngine` — the `summarize()` and `compactNow()` overrides, plus tool and command registration. |
| `src/dsh/` | DSH glue: message adapter, session-event loader, recall view, tool, commands, seq alignment, previous-summary handling, manual-span extension. |
| `src/core/`, `src/extract/` | pi-vcc core, vendored from upstream. See `PATCHES.md`. |
| `tests/upstream/` | Upstream's test suite for the vendored core (257 tests). |
| `tests/dsh/` | Integration tests for the glue against a fake event-backed session. |

## Test

```bash
node --test tests/upstream/*.test.ts tests/dsh/*.test.ts
```

The package ships TypeScript source; Node's type stripping runs it directly, so
there is no build step. `tsconfig.json` is for editors only.

`scripts/sync-upstream.py --upstream <pi-vcc checkout>` re-vendors the core and
reapplies the documented changes, so an upstream bump is a reviewable diff.

## Attribution

pi-vcc 0.11.2, commit `2da84918`, MIT © 2026 sting8k. Upstream in turn credits
VCC (lllyasviel) as inspiration and ports `mode:"touched"`, `#N:path`, and the
session-global index rule from pi-blackhole (k0valik). See `NOTICE`.