// timeline の記録と推測。$ に触れない純粋な関数だけを置き、テストから直接呼べるようにする。
// 受け取った Run は凍結されている前提で、いつも新しいオブジェクトを返す。

import type {
  TimelineAgent,
  TimelineBatch,
  TimelineRow,
  TimelineRun,
  TimelineRunSummary,
  TimelineTask,
  TimelineTool,
  TimelineVerdict,
} from 'claude-code'

/** 1 回の実行で記録する行とツール呼び出しの上限 */
export const MAX_ITEMS = 2000
/** 過去の実行を残す数 */
export const MAX_RUNS = 20
/** 保存するときに 1 エージェントあたり残すツール呼び出しの数 (新しい順) */
export const STORED_TOOLS_PER_AGENT = 40
/** ツール呼び出しの要約の最大文字数 */
const SUMMARY_CHARS = 80

export function emptyRun(id: string, at: number): TimelineRun {
  return { id, startedAt: at, updatedAt: at, rows: [], agents: {}, tasks: {}, batches: [], items: 0, dropped: 0 }
}

// ---------------------------------------------------------------- レーン

/** 動いているエージェントが使っているレーン。0 はメインの会話で、いつも含む */
export function activeLanes(run: TimelineRun): number[] {
  const lanes = new Set<number>([0])
  for (const agent of Object.values(run.agents)) if (agent.status === 'running') lanes.add(agent.lane)
  return [...lanes].sort((a, b) => a - b)
}

function freeLane(run: TimelineRun): number {
  const used = new Set(activeLanes(run))
  let lane = 1
  while (used.has(lane)) lane += 1
  return lane
}

function laneOf(run: TimelineRun, agentId: string | undefined): number {
  if (agentId === undefined) return 0
  return run.agents[agentId]?.lane ?? 0
}

function pushRow(run: TimelineRun, row: TimelineRow): TimelineRun {
  if (run.items >= MAX_ITEMS) return { ...run, dropped: run.dropped + 1 }
  return { ...run, rows: [...run.rows, row], items: run.items + 1, updatedAt: row.at }
}

// ---------------------------------------------------------------- エージェント

export type SpawnInfo = {
  agentId: string
  type: string
  description: string
  model?: string
  parentAgentId?: string
}

/** agent.spawn で新しいサブエージェントが起動した */
export function spawnAgent(run: TimelineRun, info: SpawnInfo, at: number): TimelineRun {
  if (run.agents[info.agentId]) return resumeAgent(run, info.agentId, at)
  const lane = freeLane(run)
  const agent: TimelineAgent = {
    agentId: info.agentId,
    type: info.type,
    description: info.description,
    lane,
    startedAt: at,
    status: 'running',
    tools: [],
    toolCount: 0,
    ...(info.model !== undefined ? { model: info.model } : {}),
    ...(info.parentAgentId !== undefined ? { parentAgentId: info.parentAgentId } : {}),
  }
  const next = { ...run, agents: { ...run.agents, [info.agentId]: agent } }
  return pushRow(next, { kind: 'agent', at, lane, lanes: activeLanes(next), agentId: info.agentId })
}

/** SendMessage などで、終わったサブエージェントがもう一度動き出した */
export function resumeAgent(run: TimelineRun, agentId: string, at: number): TimelineRun {
  const agent = run.agents[agentId]
  if (!agent || agent.status === 'running') return run
  const lane = activeLanes(run).includes(agent.lane) ? freeLane(run) : agent.lane
  const { endedAt: _ended, ...rest } = agent
  return {
    ...run,
    updatedAt: at,
    agents: { ...run.agents, [agentId]: { ...rest, lane, status: 'running' } },
  }
}

/** サブエージェントのターンが終わった。answer から判定を読み取る */
export function finishAgent(run: TimelineRun, agentId: string, answer: string | undefined, at: number): TimelineRun {
  const agent = run.agents[agentId]
  if (!agent) return run
  const verdict = answer === undefined ? undefined : parseVerdict(answer)
  const done: TimelineAgent = {
    ...agent,
    status: 'done',
    endedAt: agent.status === 'running' ? at : (agent.endedAt ?? at),
    ...(verdict !== undefined ? { verdict } : {}),
  }
  return { ...run, updatedAt: at, agents: { ...run.agents, [agentId]: done } }
}

/** 文字列の中で最後に出てきた APPROVED / NEEDS_CHANGES */
export function parseVerdict(text: string): TimelineVerdict | undefined {
  let found: TimelineVerdict | undefined
  for (const m of text.matchAll(/\b(APPROVED|NEEDS_CHANGES)\b/g)) found = m[1] as TimelineVerdict
  return found
}

// ---------------------------------------------------------------- ツール呼び出し

/** サブエージェント内のツール呼び出しを、そのエージェントの下に記録する */
export function recordTool(
  run: TimelineRun,
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
  isError: boolean,
  at: number,
): TimelineRun {
  const agent = run.agents[agentId]
  if (!agent) return run
  if (run.items >= MAX_ITEMS) {
    return {
      ...run,
      dropped: run.dropped + 1,
      agents: { ...run.agents, [agentId]: { ...agent, toolCount: agent.toolCount + 1 } },
    }
  }
  const entry: TimelineTool = { at, tool, summary: summarize(tool, input), ...(isError ? { isError: true as const } : {}) }
  return {
    ...run,
    updatedAt: at,
    items: run.items + 1,
    agents: {
      ...run.agents,
      [agentId]: { ...agent, tools: [...agent.tools, entry], toolCount: agent.toolCount + 1 },
    },
  }
}

const SUMMARY_FIELDS = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'subject', 'prompt']

/** ツールの引数から 1 行の要約を作る */
export function summarize(tool: string, input: Record<string, unknown>): string {
  let text = ''
  if (tool === 'TaskUpdate') {
    text = ['#' + String(input.taskId ?? '?'), input.status, input.subject].filter((v) => typeof v === 'string').join(' ')
  } else {
    for (const field of SUMMARY_FIELDS) {
      const value = input[field]
      if (typeof value === 'string' && value.trim() !== '') {
        text = value
        break
      }
    }
    if (text === '') {
      const first = Object.values(input).find((v) => typeof v === 'string')
      text = typeof first === 'string' ? first : ''
    }
  }
  return truncate(text.replace(/\s+/g, ' ').trim(), SUMMARY_CHARS)
}

function truncate(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

// ---------------------------------------------------------------- タスクとバッチ

export function createTask(run: TimelineRun, id: string, subject: string, at: number): TimelineRun {
  if (run.tasks[id]) return run
  const task: TimelineTask = { id, subject, status: 'pending' }
  return { ...run, updatedAt: at, tasks: { ...run.tasks, [id]: task } }
}

/**
 * タスクの状態が変わった。
 * in_progress になったタスクは、開いているバッチ (まだ全部が終わっていないもの) に加える。
 * 開いているバッチがなければ新しいバッチを始め、◆ の行を足す。
 */
export function updateTask(
  run: TimelineRun,
  id: string,
  change: { status?: string; subject?: string },
  at: number,
): TimelineRun {
  const prev: TimelineTask = run.tasks[id] ?? { id, subject: change.subject ?? '#' + id, status: 'pending' }
  const status = isTaskStatus(change.status) ? change.status : prev.status
  let task: TimelineTask = { ...prev, status, ...(change.subject !== undefined ? { subject: change.subject } : {}) }
  let next: TimelineRun = { ...run, updatedAt: at, tasks: { ...run.tasks, [id]: task } }

  if (status === 'in_progress' && task.batch === undefined) {
    const open = openBatch(next)
    if (open) {
      const batch: TimelineBatch = { ...open, taskIds: [...open.taskIds, id] }
      task = { ...task, batch: open.index }
      next = { ...next, tasks: { ...next.tasks, [id]: task }, batches: replaceBatch(next.batches, batch) }
    } else {
      const index = next.batches.length + 1
      const batch: TimelineBatch = { index, startedAt: at, taskIds: [id] }
      task = { ...task, batch: index }
      next = { ...next, tasks: { ...next.tasks, [id]: task }, batches: [...next.batches, batch] }
      next = pushRow(next, { kind: 'batch', at, lane: 0, lanes: activeLanes(next), batch: index })
    }
  }

  if ((status === 'completed' || status === 'deleted') && task.batch !== undefined) {
    const batch = next.batches.find((b) => b.index === task.batch)
    if (batch && batch.closedAt === undefined && batch.taskIds.every((t) => isFinished(next.tasks[t]))) {
      next = { ...next, batches: replaceBatch(next.batches, { ...batch, closedAt: at }) }
    }
  }
  return next
}

function isTaskStatus(value: unknown): value is TimelineTask['status'] {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
}

function isFinished(task: TimelineTask | undefined): boolean {
  return task === undefined || task.status === 'completed' || task.status === 'deleted'
}

function openBatch(run: TimelineRun): TimelineBatch | undefined {
  const last = run.batches[run.batches.length - 1]
  return last && last.closedAt === undefined ? last : undefined
}

function replaceBatch(batches: TimelineBatch[], batch: TimelineBatch): TimelineBatch[] {
  return batches.map((b) => (b.index === batch.index ? batch : b))
}

// ---------------------------------------------------------------- コミット

/** Bash のコマンドが git commit かどうか */
export function isGitCommit(command: string): boolean {
  return /(?:^|[\s;&|(])git\s+(?:-[Cc]\s+\S+\s+)*commit(?=$|[\s;&|)])/.test(command)
}

/** git commit の出力の 1 行目 `[branch abc1234] subject` を読む */
export function parseCommitOutput(text: string): { sha: string; subject: string } | undefined {
  const m = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s+(.+)$/m.exec(text)
  return m ? { sha: m[1]!, subject: m[2]!.trim() } : undefined
}

/** `git log -1 --format=%h%x09%s` の出力を読む */
export function parseLogLine(stdout: string): { sha: string; subject: string } | undefined {
  const m = /^([0-9a-f]{7,40})\t(.*)$/m.exec(stdout)
  return m ? { sha: m[1]!, subject: m[2]!.trim() } : undefined
}

/** `git -C <dir> commit` の <dir>。引用符は外す */
export function gitDirOf(command: string): string | undefined {
  const m = /git\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)
  return m ? m[1]!.replace(/^["']|["']$/g, '') : undefined
}

/** コミットの行を足す。同じ sha がすでにあれば足さない */
export function recordCommit(
  run: TimelineRun,
  agentId: string | undefined,
  commit: { sha?: string; subject: string },
  at: number,
): TimelineRun {
  const sha = commit.sha?.slice(0, 7)
  if (sha !== undefined && run.rows.some((r) => r.kind === 'commit' && r.sha === sha)) return run
  const lane = laneOf(run, agentId)
  return pushRow(run, {
    kind: 'commit',
    at,
    lane,
    lanes: activeLanes(run),
    subject: truncate(commit.subject, SUMMARY_CHARS),
    ...(sha !== undefined ? { sha } : {}),
  })
}

// ---------------------------------------------------------------- 表示用の文字列

/** git log --graph 風のレーン表示。row.lane に記号、動いているレーンに │ を置く */
export function graphOf(row: TimelineRow, width: number, symbol: string): string {
  const cells: string[] = []
  for (let lane = 0; lane < width; lane += 1) {
    cells.push(lane === row.lane ? symbol : row.lanes.includes(lane) ? '│' : ' ')
  }
  return cells.join(' ')
}

/** 表示に必要なレーンの数 */
export function graphWidth(run: TimelineRun): number {
  let max = 0
  for (const row of run.rows) {
    max = Math.max(max, row.lane, ...row.lanes)
  }
  return max + 1
}

export const SYMBOLS = { agent: '●', commit: '✔', batch: '◆' } as const

export function clockText(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function dateTimeText(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** 行の「内容」部分 */
export function rowText(run: TimelineRun, row: TimelineRow): string {
  switch (row.kind) {
    case 'agent': {
      const a = run.agents[row.agentId]
      if (!a) return '(不明なエージェント)'
      const head = `${a.type} 「${a.description}」${a.model ? ' ' + a.model : ''}`
      const tools = `tools ${a.toolCount}`
      if (a.status === 'running') return `${head} · ${tools} · 実行中…`
      const took = a.endedAt !== undefined ? ' · ' + durationText(a.endedAt - a.startedAt) : ''
      return `${head} · ${tools}${took}${a.verdict ? ' · ' + a.verdict : ''}`
    }
    case 'commit':
      return `${row.sha ?? 'commit'} ${row.subject}`
    case 'batch': {
      const b = run.batches.find((x) => x.index === row.batch)
      if (!b) return `バッチ ${row.batch}`
      const tasks = b.taskIds.map((id) => run.tasks[id]).filter((t): t is TimelineTask => t !== undefined)
      const done = tasks.filter((t) => t.status === 'completed').length
      const names = tasks.map((t) => t.subject).join(', ')
      return `バッチ ${b.index} · ${done}/${tasks.length} 完了 · ${names}`
    }
  }
}

/** 1 行分の文字列「時刻 · 記号 · 内容」 */
export function rowLine(run: TimelineRun, row: TimelineRow, width: number): string {
  return `${clockText(row.at)} ${graphOf(row, width, SYMBOLS[row.kind])}  ${rowText(run, row)}`
}

// ---------------------------------------------------------------- 保存

/** $.store に保存する前に、古いツール呼び出しを落として小さくする */
export function compactForStore(run: TimelineRun): TimelineRun {
  const agents: { [id: string]: TimelineAgent } = {}
  for (const [id, a] of Object.entries(run.agents)) {
    agents[id] = a.tools.length > STORED_TOOLS_PER_AGENT ? { ...a, tools: a.tools.slice(-STORED_TOOLS_PER_AGENT) } : a
  }
  return { ...run, agents }
}

export function summaryOf(run: TimelineRun): TimelineRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    agents: Object.keys(run.agents).length,
    commits: run.rows.filter((r) => r.kind === 'commit').length,
    batches: run.batches.length,
  }
}

/** 実行の一覧を更新する。新しい順に並べ、上限を超えた分の id を返す */
export function updateIndex(
  index: readonly TimelineRunSummary[],
  summary: TimelineRunSummary,
): { index: TimelineRunSummary[]; evicted: string[] } {
  const merged = [summary, ...index.filter((s) => s.id !== summary.id)].sort((a, b) => b.startedAt - a.startedAt)
  return { index: merged.slice(0, MAX_RUNS), evicted: merged.slice(MAX_RUNS).map((s) => s.id) }
}

/** 記録が空かどうか (何も起きていない実行は保存しない) */
export function isEmptyRun(run: TimelineRun): boolean {
  return run.rows.length === 0 && Object.keys(run.agents).length === 0
}
