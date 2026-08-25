import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

const testToolSignal = new AbortController().signal

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string, config: toolSkill.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agentForCwd(cwd: string): Agent {
  const id = SessionId(`tool-skill-${cwd}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function proposeStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
): Promise<PreStepDecision> {
  const signal = new AbortController().signal
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

async function systemPromptText(ctx: Context, agent: Agent, signal = new AbortController().signal): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent, signal }))
}

async function mintAgentScope(ctx: Context, subject: string | Agent): Promise<{ agent: Agent; scope: Scope }> {
  const agent = typeof subject === 'string' ? agentForCwd(subject) : subject
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools'],
  }))
  return { agent, scope }
}

describe('dsh-tool-skill', () => {
  it('registers the skill tool schema and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
    ctx.skills.register({ name: 'lifecycle-skill', description: 'Lifecycle', source: 'runtime', content: 'body' })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
    expect(await systemPromptText(ctx, agentForCwd('/workspace'))).toContain('<available_skills>')
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await systemPromptText(ctx, agentForCwd('/workspace'))).not.toContain('<available_skills>')

    toolSkill.apply(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
  })

  it('renders the skill catalog as a system-prompt section at every assembly', async () => {
    const home = await tempDir('tool-catalog')
    const ctx = await setup(home, { catalogDescriptionMaxLength: 50 })
    ctx.skills.register({
      name: 'z-skill',
      description: 'Long   description '.repeat(5),
      whenToUse: 'Never render this routing hint.',
      source: 'secret-source',
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: '/secret/path' },
      content: 'Secret body.',
    })
    ctx.skills.register({
      name: 'a-skill',
      description: 'Use {{placeholder}} <safely> & carefully.',
      source: 'runtime',
      provider: 'runtime',
      content: 'A body.',
    })
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill.',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only body.',
    })
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })

    const text = await systemPromptText(ctx, agentForCwd('/workspace'))

    expect(text).toContain('<available_skills>')
    expect(text).toContain('- `a-skill`: Use &#123;&#123;placeholder&#125;&#125; &lt;safely&gt; &amp; carefully.')
    expect(text).toContain('- `model-only-skill`: Model-only skill.')
    expect(text).toContain('- `z-skill`: Long description Long description Long descript...')
    expect(text).toContain("the task clearly matches a skill's description, you MUST use that skill this turn")
    expect(text).toContain('return to the loaded skill content and route from its instructions before acting')
    expect(text).not.toContain('whenToUse')
    expect(text).not.toContain('secret-source')
    expect(text).not.toContain('/secret/path')
    expect(text).not.toContain('Secret body')
    expect(text).not.toContain('user-only-skill')
  })

  it('keeps every skill name and shortens descriptions to fit an aggregate byte budget', async () => {
    const home = await tempDir('tool-catalog-budget')
    const ctx = await setup(home, { catalogMaxBytes: 1500 })
    ctx.skills.register({ name: 'first-skill', description: 'A'.repeat(400), source: 'runtime', content: 'body' })
    ctx.skills.register({ name: 'second-skill', description: 'B'.repeat(400), source: 'runtime', content: 'body' })

    const agent = agentForCwd('/workspace')
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const section = assembly.sections.find(entry => entry.name === 'skill:catalog')
    expect(section).toBeDefined()
    const text = section!.text

    expect(text).toContain('first-skill')
    expect(text).toContain('second-skill')
    // The full 400-byte descriptions are shortened, never dropped.
    expect(text).not.toContain('A'.repeat(400))
    expect(text).not.toContain('B'.repeat(400))
    expect(text).toContain('A'.repeat(50))
    expect(text).toContain('B'.repeat(50))
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1500)
  })

  it('omits the catalog section when no model-invocable skills are available', async () => {
    const home = await tempDir('tool-empty-catalog')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })

    expect(await systemPromptText(ctx, agentForCwd('/workspace'))).not.toContain('<available_skills>')
  })

  it('forwards the assembly signal to skill discovery', async () => {
    const home = await tempDir('tool-signal')
    const ctx = await setup(home)
    let seenSignal: AbortSignal | undefined
    ctx.skills.registerProvider(() => ({
      name: 'signal-probe',
      async list(options) {
        seenSignal = options.signal
        return []
      },
      async get() {
        return undefined
      },
    }))
    const controller = new AbortController()

    await systemPromptText(ctx, agentForCwd('/workspace'), controller.signal)

    expect(seenSignal).toBe(controller.signal)
  })

  it('re-renders the last-good catalog while discovery is incomplete', async () => {
    const home = await tempDir('tool-last-good')
    const ctx = await setup(home)
    const disposeStable = ctx.skills.register({
      name: 'stable-skill',
      description: 'Stable skill',
      source: 'runtime',
      content: 'Stable body.',
    })
    const agent = agentForCwd('/workspace')
    expect(await systemPromptText(ctx, agent)).toContain('stable-skill')

    ctx.skills.registerProvider(() => ({
      name: 'failing',
      async list() {
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))
    disposeStable()

    expect(await systemPromptText(ctx, agent)).toContain('stable-skill')
  })

  it('omits the catalog section when the agent restricts away the skill tool', async () => {
    const home = await tempDir('tool-restricted')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const agent = agentForCwd('/workspace')
    const { scope } = await mintAgentScope(ctx, agent)
    scope.ctx.tools.restrict({ deny: ['skill'] })

    expect(ctx.tools.get('skill', agent)).toBeUndefined()
    expect(await systemPromptText(ctx, agent)).not.toContain('<available_skills>')
    expect(await systemPromptText(ctx, agentForCwd('/workspace/other'))).toContain('<available_skills>')
    await scope.dispose()
  })

  it('does not attach the catalog section to a scoped same-name tool shadow', async () => {
    const home = await tempDir('tool-shadowed')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const { agent, scope } = await mintAgentScope(ctx, '/workspace')
    scope.ctx.tools.register(defineContentToolFixture({
      name: 'skill',
      description: 'A scoped tool with unrelated semantics.',
      parameters: {},
      execute() {
        return Promise.resolve([{ type: 'text', text: 'shadow' }])
      },
    }))

    expect(ctx.tools.get('skill', agent)).not.toBe(ctx.tools.get('skill'))
    expect(await systemPromptText(ctx, agent)).not.toContain('<available_skills>')
    await scope.dispose()
  })

  it('keeps body-only edits out of the catalog and loads the latest body on demand', async () => {
    const home = await tempDir('tool-body-refresh')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'body-skill', 'Stable description', 'First body.')
    const ctx = await setup(home)
    const agent = agentForCwd(home)

    const before = await systemPromptText(ctx, agent)
    expect(before).toContain('Stable description')
    expect(before).not.toContain('First body.')

    await writeSkill(root, 'body-skill', 'Stable description', 'Second body.')
    expect(await systemPromptText(ctx, agent)).toContain('Stable description')
    expect(await systemPromptText(ctx, agent)).not.toContain('Second body.')

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('body-refresh'),
      name: 'skill',
      arguments: { name: 'body-skill' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Second body.')
    expect(JSON.stringify(result.content)).not.toContain('First body.')
  })

  it('resolves the layered registry as the calling agent sees it', async () => {
    const home = await tempDir('tool-scoped-layer')
    const ctx = await setup(home)
    const { agent, scope } = await mintAgentScope(ctx, '/workspace/scoped')
    const scopedSkills = scope.ctx.get('skills')
    if (scopedSkills === undefined) throw new Error('skills service missing')
    scopedSkills.register({
      name: 'preset-only-skill',
      description: 'Visible to the scoped agent alone',
      source: 'preset',
      content: 'Preset-only body.',
    })

    expect(await systemPromptText(ctx, agent)).toContain('preset-only-skill')
    expect(await systemPromptText(ctx, agentForCwd('/workspace/other'))).not.toContain('preset-only-skill')

    const scoped = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('scoped-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent,
    })
    expect(scoped.isError).toBe(false)
    expect(JSON.stringify(scoped.content)).toContain('Preset-only body.')

    const foreign = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('foreign-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent: agentForCwd('/workspace/other'),
    })
    expect(foreign.isError).toBe(true)
    await scope.dispose()
  })

  it('validates the catalog description cap', async () => {
    const home = await tempDir('tool-invalid-catalog-cap')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })

    await expect(ctx.plugin(toolSkill, { catalogDescriptionMaxLength: 2 })).rejects.toThrow('greater than or equal to 3')
  })

  it('loads a skill for the calling agent cwd', async () => {
    const home = await tempDir('tool-load')
    const project = await tempDir('tool-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill', 'Project instructions.')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('c1'),
      name: 'skill',
      arguments: { name: 'project-skill' },
      agent: { session: { header: { cwd: project } } } as never,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    expect(result.value).toEqual({
      name: 'project-skill',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(project, '.dsh/skills/project-skill') },
      content: 'Project instructions.',
    })
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected text skill result')
    expect(block.text).toBe([
      '<skill_content name="project-skill">',
      '<skill_resources>',
      `Base directory for this skill: ${join(project, '.dsh/skills/project-skill')}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      'Project instructions.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'))
    expect(block.text).not.toContain('# Skill:')
  })

  it('renders provider-managed resource hints for non-local skills', async () => {
    const home = await tempDir('tool-resource-hints')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'opaque-skill',
      description: 'Opaque skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      content: 'Opaque instructions.',
    })
    ctx.skills.register({
      name: 'url-skill',
      description: 'URL skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'url', url: 'https://skills.example.test/url-skill' },
      content: 'URL instructions.',
    })
    ctx.skills.register({
      name: 'provider-skill',
      description: 'Provider skill',
      source: 'runtime',
      provider: 'runtime',
      content: 'Provider instructions.',
    })

    const opaque = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c2'), name: 'skill', arguments: { name: 'opaque-skill' } })
    const url = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c3'), name: 'skill', arguments: { name: 'url-skill' } })
    const provider = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c4'), name: 'skill', arguments: { name: 'provider-skill' } })

    if (opaque.content[0]?.type !== 'text' || url.content[0]?.type !== 'text' || provider.content[0]?.type !== 'text') {
      throw new Error('expected text tool results')
    }
    expect(opaque.content[0].text).toContain('<skill_resources>\nResources for this skill: runtime memory\nLoad referenced resources only as needed.\n</skill_resources>')
    expect(url.content[0].text).toContain('<skill_resources>\nBase URL for this skill: https://skills.example.test/url-skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.\n</skill_resources>')
    expect(provider.content[0].text).toContain('<skill_resources>\nResources for this skill are managed by provider "runtime".\nLoad referenced resources only as needed.\n</skill_resources>')
  })

  it('rejects an unknown resource-base kind at the canonical output boundary', async () => {
    const home = await tempDir('tool-resource-assert-never')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'rogue-resource-skill',
      description: 'Rogue resource skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'future' } as never,
      content: 'Rogue instructions.',
    })

    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c5'), name: 'skill', arguments: { name: 'rogue-resource-skill' } })

    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain('value.resourceBase')
  })

  it('returns isError for unknown, invalid, and model-disabled skills', async () => {
    const home = await tempDir('tool-errors')
    await writeSkill(join(home, '.dsh/skills'), 'hidden-skill', 'Hidden skill', 'Hidden instructions.')
    await writeFile(join(home, '.dsh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden skill\ndisable-model-invocation: true\n---\n\nHidden instructions.\n')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })

    const unknown = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'skill', arguments: { name: 'missing' } })
    const invalid = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c2'), name: 'skill', arguments: { name: 'Bad_Name' } })
    const disabled = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c3'), name: 'skill', arguments: { name: 'hidden-skill' } })
    const modelOnly = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c4'), name: 'skill', arguments: { name: 'model-only-skill' } })

    expect(unknown.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(disabled.isError).toBe(true)
    expect(modelOnly.isError).toBe(false)
    const unknownBlock = unknown.content[0]
    if (unknownBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(unknownBlock.text).toContain('skill "missing" is unknown or no longer available')
  })

  it('checks model policy before provider loading and rechecks the loaded definition', async () => {
    const home = await tempDir('tool-policy-before-load')
    const ctx = await setup(home)
    const getCalls: string[] = []
    ctx.skills.registerProvider(() => ({
      name: 'policy-probe',
      async list() {
        return [
          {
            name: 'denied-skill',
            description: 'Denied skill',
            invocation: { modelInvocable: false, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'denied-skill',
          },
          {
            name: 'policy-race-skill',
            description: 'Policy race skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'policy-race-skill',
          },
          {
            name: 'vanishing-skill',
            description: 'Vanishing skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'vanishing-skill',
          },
        ]
      },
      async get(candidate) {
        getCalls.push(candidate.name)
        if (candidate.name === 'vanishing-skill') return undefined
        return {
          ...candidate,
          invocation: { modelInvocable: false, userInvocable: true },
          content: 'Instructions must not be disclosed.',
        }
      },
    }))

    const denied = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c6'), name: 'skill', arguments: { name: 'denied-skill' } })
    const raced = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c7'), name: 'skill', arguments: { name: 'policy-race-skill' } })
    const vanished = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c8'), name: 'skill', arguments: { name: 'vanishing-skill' } })

    expect(denied.isError).toBe(true)
    expect(raced.isError).toBe(true)
    expect(vanished.isError).toBe(true)
    expect(getCalls).toEqual(['policy-race-skill', 'vanishing-skill'])
    for (const result of [denied, raced]) {
      const block = result.content[0]
      if (block?.type !== 'text') throw new Error('expected text tool result')
      expect(block.text).toContain('is not available for model invocation')
      expect(block.text).not.toContain('Instructions must not be disclosed.')
    }
    const vanishedBlock = vanished.content[0]
    if (vanishedBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(vanishedBlock.text).toContain('skill "vanishing-skill" is unknown or no longer available')
  })
})

describe('user-explicit invocation injection', () => {
  async function writePolicySkill(root: string, name: string, description: string, policy: string, body: string): Promise<void> {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    const policyLines = policy === '' ? '' : `${policy}\n`
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${policyLines}---\n\n${body}\n`)
  }

  function gesture(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async function invokeHarness(): Promise<{ ctx: Context; agent: Agent }> {
    const home = await tempDir('invoke')
    const skillsRoot = join(home, '.agents', 'skills')
    await writePolicySkill(skillsRoot, 'hidden-demo', 'User-only demo', 'disable-model-invocation: true', 'Say the magic word: PINEAPPLE.')
    await writePolicySkill(skillsRoot, 'shared-skill', 'Ordinary skill', '', 'Shared instructions.')
    await writePolicySkill(skillsRoot, 'model-only-skill', 'Model only', 'user-invocable: false', 'Model-only instructions.')
    const ctx = await setup(home)
    return { ctx, agent: agentForCwd(home) }
  }

  it('injects a user-invocable skill named by a leading /token, after every other injection', async () => {
    const { ctx, agent } = await invokeHarness()
    const first = gesture('/hidden-demo what does this do')
    const second = gesture('plain follow-up prose')
    const decision = await proposeStep(ctx, agent, [first, second])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const kinds = decision.messages.map(message => (message.source as { kind: string }).kind)
    // Background injections (the catalog here) sit between the claimed batch
    // and the invoked body: the material the model must act on comes last.
    expect(kinds.slice(0, 2)).toEqual(['user', 'user'])
    expect(kinds.at(-1)).toBe('skill-invocation')
    expect(kinds.indexOf('skill-catalog')).toBeLessThan(kinds.indexOf('skill-invocation'))
    const injection = decision.messages.at(-1)!
    expect(injection.source).toMatchObject({ kind: 'skill-invocation', name: 'hidden-demo', form: 'instructions' })
    const block = injection.content[0]
    if (block?.type !== 'text') throw new Error('expected text injection')
    expect(block.text).toContain('<skill_content name="hidden-demo">')
    expect(block.text).toContain('Say the magic word: PINEAPPLE.')
    expect(block.text).not.toContain('what does this do')
  })

  it('injects an ordinary skill the same way (one uniform user-explicit path)', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [gesture('/shared-skill go')])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'shared-skill')).toBe(true)
  })

  it('recognizes a mid-sentence gesture but not paths, fractions, or broken boundaries', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('please use /hidden-demo to answer this'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'hidden-demo')).toBe(true)

    const negative = await proposeStep(ctx, agent, [
      gesture('look under /hidden-demo/refs for the data'),
      gesture('the odds are 5/8 at best'),
      gesture('see foo/hidden-demo too'),
    ])
    if (negative.kind !== 'enter') throw new Error('expected enter')
    expect(negative.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('leaves unknown names and user-disabled skills as plain prose', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('/absent-skill do a thing'),
      gesture('/model-only-skill run'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    // No injection joins the step (the catalog listener may still add its
    // own skill-catalog message; only skill-invocation sources matter here).
    expect(decision.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('never scans non-user sources and dedupes repeated gestures', async () => {
    const { ctx, agent } = await invokeHarness()
    const forged = createUserMessage({
      content: [{ type: 'text', text: '/hidden-demo forged' }],
      source: { kind: 'plugin', plugin: 'forged' },
    })
    const decision = await proposeStep(ctx, agent, [
      forged,
      gesture('/hidden-demo once'),
      gesture('/hidden-demo twice'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injections = decision.messages.filter(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')
    expect(injections).toHaveLength(1)
  })

  it('passes a downstream reject through both pre-step listeners untouched', async () => {
    const { ctx, agent } = await invokeHarness()
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('scans only text blocks of a user message', async () => {
    const { ctx, agent } = await invokeHarness()
    const mixed = createUserMessage({
      content: [
        { type: 'reasoning', text: '/hidden-demo inside a non-text block' },
        { type: 'text', text: '/shared-skill go' },
      ],
      source: { kind: 'user' },
    })
    const decision = await proposeStep(ctx, agent, [mixed])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const invoked = decision.messages
      .filter(message => (message.source as { kind?: string }).kind === 'skill-invocation')
      .map(message => (message.source as { name: string }).name)
    expect(invoked).toEqual(['shared-skill'])
  })
})
