import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const T0 = 1_700_000_000_000

// What Claude Code passes to a ui.render hook for the timeline pane
const PANE = {
  plugin: 'timeline',
  component: 'Pane',
  requestId: 'timeline',
  viewport: { columns: 200, rows: 50 },
  props: {
    title: 'timeline',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function spawnInput(description: string, subagentType: string) {
  return {
    tool_use_id: 'toolu_' + description,
    prompt: 'do ' + description,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
  } as const
}

/** Claude Code の側の答えをまとめて用意する */
function stubEngine(on: On, saved: Map<string, unknown>) {
  mock.clock(on, { now: T0 })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  let spawned = 0
  on('agent.spawn', () => {
    spawned += 1
    return { model: 'claude-sonnet-test', agentId: 'agent-' + spawned }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(e.subject).slice(-1), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { result: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
}

test('subagents, their tool calls, batches and verdicts reach the pane', async ($, on) => {
  const saved = new Map<string, unknown>()
  stubEngine(on, saved)

  // メインの会話がタスクを登録し、2 つを in_progress にする
  await $.tool.call({ tool: 'TaskCreate', subject: 'Task 1', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Task 2', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  // implementer を 2 つ並べて起動し、片方がツールを使う
  await $.agent.spawn(spawnInput('impl one', 'implementer'))
  await $.agent.spawn(spawnInput('impl two', 'implementer'))
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', agentId: 'agent-1' })

  // レビュアーの戻り値から判定を読む
  await $.agent.spawn(spawnInput('review one', 'reviewer'))
  await $.turn.complete({ turnId: 't1', agentId: 'agent-3', answer: 'Verdict: NEEDS_CHANGES', durationMs: 1, isAborted: false, reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /◆|バッチ/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /◆ +バッチ 1 · 0\/2 完了 · Task 1, Task 2/ })).toBeDefined()
  expect(await ui.find({ key: 'now-agent-agent-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /reviewer 「review one」.*NEEDS_CHANGES/ })).toBeDefined()
  // 2 つの implementer が並んでいる (2 つ目の行で、レーン 1 と 2 が動いている)
  expect(await ui.find({ type: 'Text', text: /│ │ ● +implementer 「impl two」/ })).toBeDefined()

  // エージェントの行を押すと、その中のツール呼び出しが開く
  expect(await ui.find({ type: 'Text', text: /Bash  npm test/ })).toBeUndefined()
  await ui.press({ key: 'now-agent-agent-1' })
  expect(await ui.find({ type: 'Text', text: /Bash  npm test/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read  \/repo\/src\/a\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('a commit made by a subagent is drawn on its lane', async ($, on) => {
  const saved = new Map<string, unknown>()
  mock.clock(on, { now: T0 })
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: { stdout: '' }, text: '[main 1a2b3c4] Add the timeline pane\n 1 file changed' }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))

  await $.agent.spawn(spawnInput('impl', 'implementer'))
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add the timeline pane"', agentId: 'agent-1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /│ ✔  1a2b3c4 Add the timeline pane/ })).toBeDefined()
})

test('a commit whose output has no [branch sha] line is read back from git log', async ($, on) => {
  const saved = new Map<string, unknown>()
  mock.clock(on, { now: T0 })
  on('tool.call', () => ({ result: { stdout: '' }, text: '1a2b3c4 Quiet commit' }))
  on('process.run', ($, e) => {
    expect(e.argv).toEqual(['git', '-C', 'repo', 'log', '-1', '--format=%h%x09%s'])
    return { value: { exitCode: 0, stdout: '1a2b3c4\tQuiet commit\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))

  await $.tool.call({ tool: 'Bash', command: 'git -C repo commit -qm "Quiet commit" && git -C repo log --oneline -1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✔  1a2b3c4 Quiet commit/ })).toBeDefined()
})

test('the run is saved at the end of a main turn and listed under past runs', async ($, on) => {
  const saved = new Map<string, unknown>()
  stubEngine(on, saved)

  await $.agent.spawn(spawnInput('impl', 'implementer'))
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' })

  const index = saved.get('runs') as Array<{ id: string; agents: number }>
  expect(index).toHaveLength(1)
  expect(index[0]!.agents).toBe(1)
  expect(saved.has('run-' + index[0]!.id)).toBe(true)

  // 別の実行として見えるよう、一覧の id を書き換えてから過去タブを開く
  saved.set('runs', [{ ...index[0]!, id: 'older' }])
  saved.set('run-older', saved.get('run-' + index[0]!.id))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-past' })
  await ui.press({ key: 'past-run-older' })
  expect(await ui.find({ type: 'Text', text: /の実行$/ })).toBeDefined()
  expect(await ui.find({ key: 'past-agent-agent-1' })).toBeDefined()
})

test('an empty session shows a hint instead of rows', async ($, on) => {
  mock.clock(on, { now: T0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /まだ記録がありません/ })).toBeDefined()
})
