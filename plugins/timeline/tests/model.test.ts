import { expect, test } from 'claude-code/testing'
import {
  MAX_ITEMS,
  MAX_RUNS,
  STORED_TOOLS_PER_AGENT,
  compactForStore,
  createTask,
  emptyRun,
  finishAgent,
  graphOf,
  graphWidth,
  gitDirOf,
  isGitCommit,
  parseCommitOutput,
  parseLogLine,
  parseVerdict,
  recordCommit,
  recordTool,
  rowText,
  spawnAgent,
  summarize,
  summaryOf,
  updateIndex,
  updateTask,
} from '../hooks/model.js'

const T0 = 1_700_000_000_000

function spawn(run = emptyRun('r', T0), id = 'a1', at = T0 + 1) {
  return spawnAgent(run, { agentId: id, type: 'implementer', description: 'task ' + id, model: 'sonnet' }, at)
}

test('concurrent agents get side-by-side lanes and free them when done', async () => {
  let run = spawn(undefined, 'a1', T0 + 1)
  run = spawn(run, 'a2', T0 + 2)
  expect(run.agents.a1!.lane).toBe(1)
  expect(run.agents.a2!.lane).toBe(2)
  // a2 の行が作られた時点で、a1 のレーンも動いている
  expect(run.rows[1]!.lanes).toEqual([0, 1, 2])

  run = finishAgent(run, 'a1', 'done. APPROVED', T0 + 3)
  run = spawn(run, 'a3', T0 + 4)
  // a1 が空けたレーン 1 を使い回す
  expect(run.agents.a3!.lane).toBe(1)
  expect(graphWidth(run)).toBe(3)
  expect(graphOf(run.rows[2]!, 3, '●')).toBe('│ ● │')
})

test('a verdict is the last APPROVED or NEEDS_CHANGES in the answer', async () => {
  expect(parseVerdict('Not APPROVED yet. Verdict: NEEDS_CHANGES')).toBe('NEEDS_CHANGES')
  expect(parseVerdict('NEEDS_CHANGES were fixed. APPROVED')).toBe('APPROVED')
  expect(parseVerdict('looks fine')).toBeUndefined()

  let run = finishAgent(spawn(), 'a1', 'Review: APPROVED', T0 + 60_001)
  expect(run.agents.a1!.status).toBe('done')
  expect(run.agents.a1!.verdict).toBe('APPROVED')
  expect(rowText(run, run.rows[0]!)).toBe('implementer 「task a1」 sonnet · tools 0 · 1m00s · APPROVED')
  // 判定のない 2 回目の完了で、前の判定を消さない
  run = finishAgent(run, 'a1', 'ok', T0 + 62_001)
  expect(run.agents.a1!.verdict).toBe('APPROVED')
})

test('tool calls are kept under their agent with a one-line summary', async () => {
  let run = spawn()
  run = recordTool(run, 'a1', 'Bash', { command: 'npm   test\n --watch=false', description: 'Run tests' }, false, T0 + 2)
  run = recordTool(run, 'a1', 'Read', { file_path: '/src/a.ts' }, true, T0 + 3)
  run = recordTool(run, 'unknown', 'Read', { file_path: '/x' }, false, T0 + 4)
  const agent = run.agents.a1!
  expect(agent.toolCount).toBe(2)
  expect(agent.tools.map((t) => t.summary)).toEqual(['npm test --watch=false', '/src/a.ts'])
  expect(agent.tools[1]!.isError).toBe(true)
  expect(summarize('TaskUpdate', { taskId: '3', status: 'completed' })).toBe('#3 completed')
  expect([...summarize('Bash', { command: 'x'.repeat(200) })].length).toBe(80)
})

test('tasks that go in_progress together form one batch', async () => {
  let run = emptyRun('r', T0)
  for (const id of ['1', '2', '3']) run = createTask(run, id, 'Task ' + id, T0)
  run = updateTask(run, '1', { status: 'in_progress' }, T0 + 1)
  run = updateTask(run, '2', { status: 'in_progress' }, T0 + 2)
  expect(run.batches).toHaveLength(1)
  expect(run.rows.filter((r) => r.kind === 'batch')).toHaveLength(1)
  expect(rowText(run, run.rows[0]!)).toBe('バッチ 1 · 0/2 完了 · Task 1, Task 2')

  run = updateTask(run, '1', { status: 'completed' }, T0 + 3)
  expect(run.batches[0]!.closedAt).toBeUndefined()
  run = updateTask(run, '2', { status: 'completed' }, T0 + 4)
  expect(run.batches[0]!.closedAt).toBe(T0 + 4)

  // 前のバッチが閉じたあとで in_progress になったタスクは、次のバッチ
  run = updateTask(run, '3', { status: 'in_progress' }, T0 + 5)
  expect(run.batches).toHaveLength(2)
  expect(run.tasks['3']!.batch).toBe(2)
  // 同じタスクがもう一度 in_progress になってもバッチは増えない
  run = updateTask(run, '3', { status: 'in_progress' }, T0 + 6)
  expect(run.batches).toHaveLength(2)
})

test('git commit commands and their output are recognized', async () => {
  expect(isGitCommit('git add -A && git commit -m "x"')).toBe(true)
  expect(isGitCommit('git -C repo commit --amend')).toBe(true)
  expect(isGitCommit('git commit-tree abc')).toBe(false)
  expect(isGitCommit('echo git log')).toBe(false)

  expect(parseCommitOutput('[main 1a2b3c4] Add timeline\n 2 files changed')).toEqual({ sha: '1a2b3c4', subject: 'Add timeline' })
  expect(parseCommitOutput('[feat/x (root-commit) abcdef0] First')).toEqual({ sha: 'abcdef0', subject: 'First' })
  expect(parseCommitOutput('nothing to commit, working tree clean')).toBeUndefined()

  // サブエージェントのコミットは、そのエージェントのレーンに置く
  let run = spawn()
  run = recordCommit(run, 'a1', { sha: '1a2b3c4d5e', subject: 'Add timeline' }, T0 + 2)
  const row = run.rows[1]!
  expect(row.lane).toBe(1)
  expect(rowText(run, row)).toBe('1a2b3c4 Add timeline')
  // 同じコミットを 2 度は足さない
  expect(recordCommit(run, undefined, { sha: '1a2b3c4', subject: 'Add timeline' }, T0 + 3).rows).toHaveLength(2)

  expect(parseLogLine('1a2b3c4\tAdd timeline\n')).toEqual({ sha: '1a2b3c4', subject: 'Add timeline' })
  expect(gitDirOf('git -C "my repo" commit -m x')).toBe('my repo')
  expect(gitDirOf('git commit -m x')).toBeUndefined()
})

test('recording stops at the item limit and counts what it dropped', async () => {
  let run = spawn()
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) run = recordTool(run, 'a1', 'Read', { file_path: '/f' + i }, false, T0 + i)
  expect(run.items).toBe(MAX_ITEMS)
  expect(run.dropped).toBe(6)
  expect(run.agents.a1!.toolCount).toBe(MAX_ITEMS + 5)

  const stored = compactForStore(run)
  expect(stored.agents.a1!.tools).toHaveLength(STORED_TOOLS_PER_AGENT)
  // 新しいほうを残す
  expect(stored.agents.a1!.tools[STORED_TOOLS_PER_AGENT - 1]!.summary).toBe('/f' + (MAX_ITEMS - 2))
})

test('the index keeps the newest runs and evicts the rest', async () => {
  let index: ReturnType<typeof updateIndex>['index'] = []
  const evicted: string[] = []
  for (let i = 0; i < MAX_RUNS + 2; i += 1) {
    const run = { ...emptyRun('r' + i, T0 + i * 1000) }
    const out = updateIndex(index, summaryOf(run))
    index = out.index
    evicted.push(...out.evicted)
  }
  expect(index).toHaveLength(MAX_RUNS)
  expect(index[0]!.id).toBe('r' + (MAX_RUNS + 1))
  expect(evicted).toEqual(['r0', 'r1'])
  // 同じ実行を保存し直しても重複しない
  expect(updateIndex(index, { ...index[3]!, agents: 9 }).index).toHaveLength(MAX_RUNS)
})
