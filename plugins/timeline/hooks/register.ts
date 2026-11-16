// timeline mod: サブエージェントの起動、その中のツール呼び出し、タスクのバッチ、コミットを
// git log --graph 風に並べたペインを、チャットの横に出す。
//
// - 今のセッションの記録は $.state (key: run) に置く。モジュールが再読み込みされても残る
// - 過去の実行は $.store に、実行ごとのキー (run-<id>) と一覧 (runs) で保存する

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  On,
  RenderNode,
  TimelineRun,
  TimelineRunSummary,
  TimelineTool,
  ToolCallInput,
  ToolCallResult,
} from 'claude-code'
import {
  SYMBOLS,
  clockText,
  compactForStore,
  createTask,
  dateTimeText,
  emptyRun,
  finishAgent,
  gitDirOf,
  graphOf,
  graphWidth,
  isEmptyRun,
  isGitCommit,
  parseCommitOutput,
  parseLogLine,
  recordCommit,
  recordTool,
  rowText,
  spawnAgent,
  resumeAgent,
  summaryOf,
  updateIndex,
  updateTask,
} from './model.js'

const PANE = 'timeline'
const INDEX_KEY = 'runs'
const RUN_KEY_PREFIX = 'run-'

const runAtom = atom({ plugin: 'timeline', key: 'run' }, null, { shape: 'v1' })

// ペインの表示状態。失っても困らないのでモジュール変数に置く
let tab: 'now' | 'past' = 'now'
const expanded = new Set<string>()
let pastIndex: TimelineRunSummary[] = []
let pastRun: TimelineRun | undefined

type Step = (run: TimelineRun) => TimelineRun

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await loadIndex($)
    try {
      await $.command.register({
        name: 'timeline',
        description: 'timeline ペインを開く (close で閉じる、past で過去の実行を表示)',
        argumentHint: '[close|past]',
        immediate: true,
      })
    } catch {
      // 名前が使えないときもペインは開く
    }
    try {
      await $.ui.open({ id: PANE, title: 'timeline' })
    } catch {
      // すでに開いている
    }
    return result
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    tab = arg === 'past' ? 'past' : 'now'
    if (tab === 'past') await loadIndex($)
    try {
      await $.ui.open({ id: PANE, title: 'timeline', focus: true })
    } catch {
      // すでに開いているときは描き直すだけ
    }
    $.ui.invalidate('ui.render')
    return {}
  })

  // サブエージェントの起動。start してから記録するので、agentId が分かる
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.agentId === undefined) return result
    const agentId = result.agentId
    const at = await $.clock.now()
    if (e.resume !== undefined) {
      await apply($, at, false, [(run) => resumeAgent(run, agentId, at)])
    } else {
      const info = {
        agentId,
        type: e.subagentType,
        description: e.description,
        model: result.model,
        ...(e.parentAgentId !== undefined ? { parentAgentId: e.parentAgentId } : {}),
      }
      await apply($, at, true, [(run) => spawnAgent(run, info, at)])
    }
    return result
  }).catch(async ($, e, next) => next(e))

  // すべてのツール呼び出し。結果を見てから記録する
  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const result = await next(e)
    await recordCall($, e, result, at)
    return result
  }).catch(async ($, e, next) => next(e))

  // サブエージェントのターンの終わりで完了とし、戻り値から判定を読む。
  // メインのターンの終わりでは今の実行を保存する
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId
    if (agentId !== undefined) {
      const at = await $.clock.now()
      await apply($, at, false, [(run) => finishAgent(run, agentId, e.answer, at)])
    } else {
      await saveCurrent($)
    }
    return result
  }).catch(async ($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await saveCurrent($)
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const run = await read($, runAtom)
    const redraw = () => $.ui.invalidate('ui.render')

    const tabButton = (name: 'now' | 'past', label: string, hotkey: string) =>
      Button({
        key: 'tab-' + name,
        label,
        hotkey,
        plain: true,
        ...(tab !== name ? { dimColor: true } : {}),
        onPress: async () => {
          tab = name
          if (name === 'past') {
            pastRun = undefined
            await loadIndex($)
          }
          redraw()
        },
      })

    const header = Box({
      flexDirection: 'row',
      columnGap: 3,
      children: [tabButton('now', '今回', '1'), tabButton('past', '過去', '2')],
    })

    let body: RenderNode[]
    if (tab === 'now') {
      body = run === null || isEmptyRun(run) ? [Text({ dimColor: true, children: [EMPTY_TEXT] })] : drawRun(ui, run, 'now', redraw)
    } else if (pastRun !== undefined) {
      const shown = pastRun
      body = [
        Button({
          key: 'past-back',
          label: '← 一覧へ戻る',
          plain: true,
          onPress: () => {
            pastRun = undefined
            redraw()
          },
        }),
        Text({ bold: true, children: [dateTimeText(shown.startedAt) + ' の実行'] }),
        ...drawRun(ui, shown, 'past', redraw),
      ]
    } else {
      const list = pastIndex.filter((s) => s.id !== run?.id)
      body =
        list.length === 0
          ? [Text({ dimColor: true, children: ['保存された過去の実行はまだありません。'] })]
          : list.map((s) =>
              Button({
                key: 'past-run-' + s.id,
                label: `${dateTimeText(s.startedAt)} · エージェント ${s.agents} · コミット ${s.commits} · バッチ ${s.batches}`,
                plain: true,
                onPress: async () => {
                  const stored = await $.store.get(RUN_KEY_PREFIX + s.id)
                  pastRun = isRun(stored) ? stored : undefined
                  redraw()
                },
              }),
            )
    }

    return Box({ flexDirection: 'column', children: [header, Text({ children: [' '] }), ...body] })
  })
}

const EMPTY_TEXT = 'まだ記録がありません。サブエージェントが起動するとここに表示されます。'

type Api = EngineInterface
type Elements = ReturnType<Api['ui']['resolve']>

/** 1 回分の記録を、新しい行が上に来る順で描く */
function drawRun(ui: Elements, run: TimelineRun, scope: string, redraw: () => void): RenderNode[] {
  const { Box, Text, Button } = ui
  const width = graphWidth(run)
  const nodes: RenderNode[] = []
  const agents = Object.values(run.agents)
  const commits = run.rows.filter((r) => r.kind === 'commit').length
  nodes.push(
    Text({
      dimColor: true,
      wrap: 'truncate-end',
      children: [
        `開始 ${dateTimeText(run.startedAt)} · エージェント ${agents.length} · コミット ${commits} · バッチ ${run.batches.length}` +
          (run.dropped > 0 ? ` · 上限超過で ${run.dropped} 件省略` : ''),
      ],
    }),
  )
  for (const row of [...run.rows].reverse()) {
    const line = `${clockText(row.at)} ${graphOf(row, width, SYMBOLS[row.kind])}  ${rowText(run, row)}`
    if (row.kind !== 'agent') {
      nodes.push(Text({ wrap: 'truncate-end', ...(row.kind === 'commit' ? { color: 'green' } : { color: 'cyan' }), children: ['  ' + line] }))
      continue
    }
    const id = scope + ':' + row.agentId
    const isOpen = expanded.has(id)
    const agent = run.agents[row.agentId]
    // ▸ だけをボタンにし、本文は切り詰めた Text にする (ボタンの中身は折り返されるため)
    nodes.push(
      Box({
        flexDirection: 'row',
        children: [
          Button({
            key: `${scope}-agent-${row.agentId}`,
            label: isOpen ? '▾' : '▸',
            plain: true,
            onPress: () => {
              if (expanded.has(id)) expanded.delete(id)
              else expanded.add(id)
              redraw()
            },
          }),
          Text({ wrap: 'truncate-end', children: [' ' + line] }),
        ],
      }),
    )
    if (isOpen && agent) {
      const hidden = agent.toolCount - agent.tools.length
      const tools: RenderNode[] = agent.tools.map((t) => toolLine(ui, t))
      if (hidden > 0) tools.unshift(Text({ dimColor: true, children: [`… ほか ${hidden} 件 (古いものは省略)`] }))
      if (tools.length === 0) tools.push(Text({ dimColor: true, children: ['ツール呼び出しはまだありません'] }))
      nodes.push(Box({ flexDirection: 'column', paddingLeft: 4, children: tools }))
    }
  }
  return nodes
}

function toolLine(ui: Elements, t: TimelineTool): RenderNode {
  const { Text } = ui
  return Text({
    wrap: 'truncate-end',
    ...(t.isError ? { color: 'red' } : { dimColor: true }),
    children: [`${clockText(t.at)}  ${t.tool}${t.summary ? '  ' + t.summary : ''}${t.isError ? '  (エラー)' : ''}`],
  })
}

// ---------------------------------------------------------------- 記録

/** 今の実行に変更をまとめて書き込む。create が true なら、記録がなければ作る */
async function apply($: Api, at: number, create: boolean, steps: Step[]) {
  if (steps.length === 0) return
  await update($, runAtom, (current) => {
    if (current === null && !create) return current
    let run = current ?? emptyRun(newRunId(at), at)
    for (const step of steps) run = step(run)
    return run
  })
}

function newRunId(at: number): string {
  return at.toString(36) + '-' + Math.floor(Math.random() * 36 ** 4).toString(36)
}


/** ツール呼び出し 1 件から、記録に必要な変更を取り出す */
async function recordCall($: Api, e: ToolCallInput, result: ToolCallResult, at: number) {
  const input = e as unknown as Record<string, unknown>
  const failed = result.deny !== undefined || result.isError === true
  const agentId = e.agentId
  const steps: Step[] = []
  let create = false

  if (agentId !== undefined) {
    steps.push((run) => recordTool(run, agentId, e.tool, input, failed, at))
  }

  if (!failed) {
    const value = (result.result ?? {}) as Record<string, unknown>
    if (e.tool === 'TaskCreate') {
      const task = value.task as { id?: unknown; subject?: unknown } | undefined
      if (task && typeof task.id === 'string') {
        const subject = typeof task.subject === 'string' ? task.subject : String(input.subject ?? '')
        const id = task.id
        steps.push((run) => createTask(run, id, subject, at))
        create = true
      }
    } else if (e.tool === 'TaskUpdate' && typeof input.taskId === 'string') {
      const id = input.taskId
      const change = {
        ...(typeof input.status === 'string' ? { status: input.status } : {}),
        ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
      }
      steps.push((run) => updateTask(run, id, change, at))
      create = true
    } else if (e.tool === 'Bash' && typeof input.command === 'string' && isGitCommit(input.command)) {
      // `git commit -q ... && git log` のように、出力に [branch sha] の行がないこともある
      const commit = parseCommitOutput(result.text ?? '') ?? (await headCommit($, input.command))
      if (commit) {
        steps.push((run) => recordCommit(run, agentId, commit, at))
        create = true
      }
    } else if (e.tool === 'Agent' && value.status === 'completed' && typeof value.agentId === 'string') {
      // フォアグラウンドのサブエージェントは、ここで戻り値の文字列が手に入る
      const doneId = value.agentId
      const content = Array.isArray(value.content) ? value.content : []
      const text = content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      steps.push((run) => finishAgent(run, doneId, text, at))
    }
  }
  await apply($, at, create, steps)
}

/** コミットしたリポジトリの HEAD を読む。`git -C <dir>` があればそこを見る */
async function headCommit($: Api, command: string): Promise<{ sha: string; subject: string } | undefined> {
  const dir = gitDirOf(command)
  const argv = ['git', ...(dir !== undefined ? ['-C', dir] : []), 'log', '-1', '--format=%h%x09%s']
  try {
    const out = await $.process.run(argv, { timeoutMs: 5000 })
    return out.exitCode === 0 ? parseLogLine(out.stdout) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- 保存

async function loadIndex($: Api) {
  try {
    const stored = await $.store.get(INDEX_KEY)
    pastIndex = Array.isArray(stored) ? (stored as TimelineRunSummary[]) : []
  } catch {
    pastIndex = []
  }
}

async function saveCurrent($: Api) {
  const run = await read($, runAtom)
  if (run === null || isEmptyRun(run)) return
  await $.store.set(RUN_KEY_PREFIX + run.id, compactForStore(run))
  // 別のセッションが書いた分を落とさないよう、書く直前に読み直す
  const stored = await $.store.get(INDEX_KEY)
  const { index, evicted } = updateIndex(Array.isArray(stored) ? (stored as TimelineRunSummary[]) : [], summaryOf(run))
  await $.store.set(INDEX_KEY, index)
  for (const id of evicted) await $.store.delete(RUN_KEY_PREFIX + id)
  pastIndex = index
}

function isRun(value: unknown): value is TimelineRun {
  return typeof value === 'object' && value !== null && Array.isArray((value as TimelineRun).rows)
}
