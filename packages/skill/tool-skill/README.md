# @deepseek-ai/dsh-tool-skill

English | [中文](README.zh.md)

The model-facing skill catalog and `skill` tool.

Requires `ctx.agents`, `ctx.tools`, and `ctx.skills` (`inject: ['agents', 'tools', 'skills']`).

## Catalog lifecycle

At every step, the plugin contributes the ordered `name` and `description` summaries as a system-prompt section named `skill:catalog` through the `system-prompt/assemble` waterfall. The section text is re-rendered with each prompt assembly, so the catalog stays at a fixed position in the system prompt instead of sinking into message history; it neither dilutes as the session grows nor disappears when compaction hides earlier messages. The section contains only those summaries; skill bodies, paths, sources, providers, and `whenToUse` hints remain outside the catalog.

The section is contributed only when model-invocable skills exist and this exact `skill` tool is visible to the calling agent. Identity is compared against the definition this plugin registered rather than a lookup of its own name, so the plugin works mounted globally or inside one agent's composition, where `register()` files into that agent's layer alone. A restriction or scoped same-name shadow removes both the schema and the section. An incomplete provider snapshot re-renders the last-good entry list; the empty initial view contributes nothing.

Descriptions are normalized, XML-escaped, then brace-escaped (`{` and `}` become `&#123;` and `&#125;`) so a literal `{{...}}` in a description does not read as a `{{variable}}` reference during prompt interpolation. `catalogDescriptionMaxLength` controls normalized catalog descriptions; its default is `500` and values must be integers of at least `3`, which reserves room for a truncation ellipsis. `catalogMaxBytes` caps the whole rendered section (default `20000` bytes): when the section exceeds it, descriptions are shortened equally to fit while skill names are never truncated or dropped.

## Tool: `skill`

| Arg | Type | Notes |
|---|---|---|
| `name` | string (required) | Exact kebab-case skill name from the available skills listing. |

Execution uses the calling agent's `session.header.cwd` so workspace-sensitive providers resolve the winning skill. A successful call returns canonical `{ name, provider, resourceBase?, content }`, excluding catalog ranking and provider-internal machinery; its Native renderer produces one text result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`.

Resource guidance resolves only paths or URLs explicitly referenced by the instructions against `resourceBase`; scripts, references, and assets load on demand, and the result does not enumerate a skill directory. Local providers may supply a directory, while remote or embedded providers may supply a URL or opaque loading guidance.

An unresolved name reports that the skill is unknown or no longer available. Invalid names and skills whose `invocation.modelInvocable` is `false` produce distinct error results. `invocation.userInvocable` does not restrict this model-facing tool.

Tool execution does not add a synthetic context message. Its freshly loaded result is already recorded as the tool result and becomes available to the next model step without duplicating the body. Only the catalog projection adds replacement summaries.

## Model Experience

### Session catalog

#### What the model sees

If model-invocable skills exist and this exact `skill` tool is visible, the system prompt carries the catalog section below at every step, with one data-dependent entry per sorted skill. The rule is mandatory and accountable: matching a skill's description obligates its use, and skipping an obvious match requires an explanation. The closing sentence is the rule against double-loading: the user-explicit gesture boundary (the pre-step listener below) injects the same `renderSkillContent` output (shared from `@deepseek-ai/dsh-skill`) inline, and the catalog tells the model to follow that block instead of re-loading the skill through the tool.

##### Skill catalog template

```markdown
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, you MUST use that skill this turn. Announce which skills you are using and why. If you skip an obviously-matching skill, say why. Do not carry skills across turns unless re-mentioned. Call the `skill` tool with the exact skill name to load the full instructions before acting; the entries above are summaries only.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
```

#### Token effect

Per-step system-prompt input scales with skill count and `catalogDescriptionMaxLength`; no catalog section is contributed when the list is empty or the tool is hidden or shadowed. `catalogMaxBytes` (default `20000`) shortens descriptions — never names — to keep the whole section under that byte cap.

#### KV Cache effect

The section is part of the system prompt's cached prefix. Re-rendering an unchanged catalog is free; a membership or description change rewrites the prefix once and then stays stable.

### Tool schema

#### What the model sees

The model sees the generated [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill).

#### Token effect

Fixed schema cost per request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, restrictions, or plugin lifecycle changes may invalidate reuse from this schema.

### Tool result

#### What the model sees

A successful call uses the result template and the provider-managed, directory, URL, or opaque resource guidance below.

##### Skill result template

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### Provider-managed resource guidance

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### Directory resource guidance

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL resource guidance

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### Opaque resource guidance

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token effect

Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### User-explicit invocation injection

#### What the model sees

A whitespace-bounded `/name` token anywhere in a claimed user message, naming a user-invocable skill in the workspace catalog, injects that skill's full `<skill_content>` rendering (the exact result-template shape above) as a `user`-role instructions context appended after every other injection of that step — background first, the material to act on last. Only direct user input is scanned, the check runs on the loaded definition, and unknown or user-disabled names stay ordinary prose. This is the sole entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose; the catalog's closing sentence tells the model to follow the injected block instead of re-loading it.

#### Token effect

Each gesture adds one rendered skill body to that turn as injected context — the same size as the tool result for the same skill, paid deterministically at the user's request instead of at the model's discretion. Repeated gestures for one skill within one step inject once.

#### KV Cache effect

Append-only; the injection lands after the reusable request prefix inside the step's message batch and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The catalog omits `whenToUse`, source, and provider metadata** — routing is based only on name and a capped description; `whenToUse` remains provider metadata and is not rendered by the loaded wrapper either.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only catalog descriptions are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
- **The catalog is recomputed per step** — a resumed or forked session sees the current skill set, not the historical catalog shown earlier in the parent session.
- **Bodies are not versioned** — body-only edits do not change the catalog; a later tool call reads the current provider content while earlier tool results remain historical facts.
