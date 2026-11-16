declare module 'claude-code' {
  interface PluginState {
    timeline: {
      run: Shaped<TimelineRun | null>
    }
  }

  /** サブエージェントの判定結果。戻り値の文字列から読み取る */
  type TimelineVerdict = 'APPROVED' | 'NEEDS_CHANGES'

  /** サブエージェント内のツール呼び出し 1 件 */
  type TimelineTool = {
    at: number
    tool: string
    summary: string
    isError?: true
  }

  /** 起動したサブエージェント 1 体 */
  type TimelineAgent = {
    agentId: string
    type: string
    description: string
    model?: string
    parentAgentId?: string
    lane: number
    startedAt: number
    endedAt?: number
    status: 'running' | 'done'
    verdict?: TimelineVerdict
    tools: TimelineTool[]
    toolCount: number
  }

  type TimelineTask = {
    id: string
    subject: string
    status: 'pending' | 'in_progress' | 'completed' | 'deleted'
    batch?: number
  }

  /** in_progress になったタスクのまとまり */
  type TimelineBatch = {
    index: number
    startedAt: number
    closedAt?: number
    taskIds: string[]
  }

  /** ペインの 1 行。lanes はその時点で動いていたレーン */
  type TimelineRow =
    | { kind: 'agent'; at: number; lane: number; lanes: number[]; agentId: string }
    | { kind: 'commit'; at: number; lane: number; lanes: number[]; sha?: string; subject: string }
    | { kind: 'batch'; at: number; lane: number; lanes: number[]; batch: number }

  /** 1 セッション (/clear まで) 分の記録 */
  type TimelineRun = {
    id: string
    startedAt: number
    updatedAt: number
    rows: TimelineRow[]
    agents: { [agentId: string]: TimelineAgent }
    tasks: { [taskId: string]: TimelineTask }
    batches: TimelineBatch[]
    /** 記録した行とツール呼び出しの合計 */
    items: number
    /** 上限を超えて捨てた件数 */
    dropped: number
  }

  /** 過去の実行の一覧に出す要約 */
  type TimelineRunSummary = {
    id: string
    startedAt: number
    updatedAt: number
    agents: number
    commits: number
    batches: number
  }
}
