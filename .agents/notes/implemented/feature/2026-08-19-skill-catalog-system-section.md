# Agent Note: Skill catalog moves to a per-step system-prompt section

Status: implemented

English | [中文](2026-08-19-skill-catalog-system-section.zh.md)

## Problem

The model-facing skill catalog was a durable user-role message injected once at the first step and republished only on a membership/description change. Its position was therefore fixed at the *front* of message history: as the session grew, the catalog sank further from the model's attention, and the trigger rule ("if the task clearly matches … call the `skill` tool") was advisory. The practical failure was a model that had matched nothing and never consulted the catalog — not a missing skill, but a diluted one. `@deepseek-ai/dsh-system-prompt` already assembles the system prompt once per step (`agent-loop` calls `systemPrompt.assemble` in `preStep`), so the correct, always-fresh channel existed; the catalog just did not ride it. This fully supersedes the durable-catalog lifecycle of the [skill catalog hot-refresh note](2026-07-27-skill-catalog-hot-refresh.md).

## Decision

`dsh-tool-skill` contributes the catalog as a system-prompt section named `skill:catalog` through the `system-prompt/assemble` waterfall instead of a pre-step user message:

- The listener awaits `next()`, reads the calling `Agent` and abort signal from `AssembleContext`, applies the same exact-definition visibility gate (`ctx.tools.get('skill', agent) === skillTool`), awaits `ctx.skills.snapshot`, and appends one `{ name, text }` section built from the model-invocable `name` + capped `description` summaries. Re-rendered each step, the section keeps a fixed position and survives compaction with no digest, tombstone, resume, or "retire stale names" machinery.
- Incomplete discovery re-renders the last-good entry list from a per-agent `WeakMap`; the empty initial view contributes nothing.
- The trigger rule is now mandatory and accountable: matching a description obligates use, skipping an obvious match requires an explanation, and skills do not carry across turns unless re-mentioned.
- Descriptions are brace-escaped (`{`/`}` → `&#123;`/`&#125;`, after the existing `escapeText` XML set) because section text passes through `renderPrompt`'s strict `{{variable}}` interpolation and a literal `{{placeholder}}` in a description would otherwise fail assembly as an unknown variable.

## Alternatives considered

- **Re-assert the catalog user message every step** — removes dilution without touching the system prompt, but appends a new message per step (history bloat) or moves the message (KV-cache invalidation from its old position). Rejected: the section is part of the cached system-prompt prefix, so re-rendering an unchanged catalog is free.
- **Register `systemPrompt.section()` with a function text** — declarative and order-controlled, but section text is resolved synchronously and the skill snapshot is async; a cache populated by the later `agent/pre-step` waterfall would lag one step and miss the first. Rejected in favor of the async `system-prompt/assemble` waterfall.
- **Keep the durable message and only strengthen the trigger rule** — fixes the obligation, not the visibility; the catalog would still sink. Rejected as incomplete.

## Consequences

- The catalog is no longer a durable session event: a resumed or forked session sees the current skill set, not the historical catalog. Accepted — it matches Codex, which recomputes the skill list per request rather than logging it as a message.
- `readCatalogEntries`, `catalogHistory`, `catalogMessage`, `digestCatalogEntries`, `renderCatalogMessage`, `renderCatalogUpdate`, and the `SkillCatalogSource` message source are deleted; no other package referenced `skill-catalog`.
- Model-visible token cost moves from "one retained message" to "a fixed section re-rendered each step", offset by the cache-stable system-prompt prefix.
