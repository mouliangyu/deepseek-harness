/**
 * Per-step system-prompt skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/**
 * Default aggregate cap for the rendered catalog section, in bytes. Kept at
 * 20K bytes as a conservative guardrail; deployments with more skills override
 * it. Descriptions are shortened, never names.
 */
const DEFAULT_CATALOG_MAX_BYTES = 20000
/** System-prompt section name the catalog is injected under. */
const CATALOG_SECTION_NAME = 'skill:catalog'

/** One name-and-description entry rendered into the model-facing skill catalog. */
interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
}

type CatalogEntries = readonly SkillCatalogEntry[]

/** Entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
): CatalogEntries {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description, descriptionMaxLength),
  }))
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /**
   * Maximum total byte size of the rendered catalog section. When the section
   * exceeds it, descriptions are shortened equally to fit; skill names are
   * never truncated or dropped. Defaults to `20000`.
   */
  catalogMaxBytes?: number
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  catalogMaxBytes: z.number().default(DEFAULT_CATALOG_MAX_BYTES),
})

/**
 * Register the model-facing skill loader and its per-step system-prompt
 * catalog. The catalog is emitted only when the calling agent resolves this
 * plugin's exact tool registration; a restriction or scoped same-name shadow
 * therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const catalogMaxBytes = config.catalogMaxBytes ?? DEFAULT_CATALOG_MAX_BYTES
  assertPositiveInteger('catalogMaxBytes', catalogMaxBytes, 1)

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)

  // User-explicit skill invocation: a claimed user message whose first line
  // starts with `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog and the `skill` tool below never see them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { kind: 'enter', messages: [...decision.messages, ...injections] }
  })

  // Per-step skill catalog in the system prompt. `system-prompt/assemble`
  // runs inside every step's prompt assembly, so the catalog is re-rendered
  // at a fixed position each step instead of sinking into message history —
  // the material stays visible regardless of how long the session grows or
  // what compaction hides. The exact-definition identity check keeps a scoped
  // same-name shadow from inheriting this catalog, mirroring the tool's own
  // visibility gate.
  const lastGood = new WeakMap<Agent, CatalogEntries>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    if (ctx.tools.get(skillTool.name, agent) !== skillTool) return assembled
    const signal = context.signal
    signal?.throwIfAborted()
    const snapshot = await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
    signal?.throwIfAborted()
    // Incomplete discovery keeps the last-good entry list rather than
    // dropping the catalog for a step; the empty initial view contributes
    // nothing until a model-invocable skill exists.
    const skills = snapshot.complete ? snapshot.skills.filter(isModelInvocable) : undefined
    let entries: CatalogEntries | undefined
    if (skills !== undefined) {
      entries = catalogSourceEntries(skills, catalogDescriptionMaxLength)
      lastGood.set(agent, entries)
    } else {
      entries = lastGood.get(agent)
    }
    if (entries === undefined || entries.length === 0) return assembled
    return {
      ...assembled,
      sections: [...assembled.sections, { name: CATALOG_SECTION_NAME, text: renderCatalogSection(entries, catalogMaxBytes) }],
    }
  })
}

/**
 * Model-facing catalog section text: the ordered name-and-description list and
 * the trigger rule. The rule is mandatory and accountable — matching a skill's
 * description obligates its use, and skipping an obvious match requires an
 * explanation — rather than an optional reminder.
 */
function renderCatalogSection(entries: CatalogEntries, maxBytes: number | undefined): string {
  const body = (list: CatalogEntries): string => [
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...renderCatalogEntries(list),
    '</available_skills>',
    '',
    "If the user names a skill, or the task clearly matches a skill's description, you MUST use that skill this turn. Announce which skills you are using and why. If you skip an obviously-matching skill, say why. Do not carry skills across turns unless re-mentioned. Call the `skill` tool with the exact skill name to load the full instructions before acting; the entries above are summaries only.",
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
  ].join('\n')
  if (maxBytes === undefined) return body(entries)
  const full = body(entries)
  if (utf8Bytes(full) <= maxBytes) return full
  // Shorten descriptions equally to fit. The fixed framing (the entry lines'
  // `- \`name\`: ` prefixes and the surrounding prose) is measured with empty
  // descriptions, so names are never truncated or dropped.
  const fixed = utf8Bytes(body(entries.map(entry => ({ ...entry, description: '' }))))
  const available = maxBytes - fixed
  if (available <= 0) return body(entries.map(entry => ({ ...entry, description: '' })))
  const perEntry = Math.floor(available / entries.length)
  return body(entries.map(entry => ({ ...entry, description: truncateUtf8(entry.description, perEntry) })))
}

/** UTF-8 byte length of a string, for catalog budgeting. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Longest prefix of `value` that fits in `maxBytes` UTF-8 bytes, never splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value
  let lo = 0
  let hi = value.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return value.slice(0, lo)
}

/**
 * Model-facing catalog lines, projected from the entries the section records.
 * The pseudo-XML escaping belongs to this frame. Names are `isSkillName`-validated
 * and carry no escapable character.
 */
function renderCatalogEntries(entries: CatalogEntries): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeCatalogDescription(entry.description)}`)
}

/**
 * Description prose escaped for the system-prompt section. The section text is
 * passed through `renderPrompt`'s strict `{{variable}}` interpolation, so braces
 * are HTML-entity-escaped alongside the `escapeText` set to keep a description
 * such as `{{placeholder}}` literal instead of an unknown variable reference.
 */
function escapeCatalogDescription(value: string): string {
  return escapeText(value)
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
}

/** Normalized, length-bounded description exactly as the catalog publishes it (unescaped). */
function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
