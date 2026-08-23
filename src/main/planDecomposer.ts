import type { AgentType } from '../shared/agentTypes'
import { assistantText } from './componentInference'
import type { ClaudeQuery } from './providers/claude'

/** One task as the decomposition model proposes it: dependencies are indices
 * into the same array (earlier tasks only), mapped to stable taskIds when the
 * plan is created. `agentTypeId` is the saved preset the model matched to the
 * task's nature, when one fits. */
export interface DecomposedTask {
  title: string
  prompt: string
  dependsOn: number[]
  agentTypeId?: string
}

/** Breaks a requirement into a dependency-aware task list — the AI behind the
 * planner's "Plan" button. The saved agent types ride along so the model can
 * suggest a role per task. Injected so callers stay testable without a live
 * model. */
export type PlanDecomposer = (requirement: string, types: AgentType[]) => Promise<DecomposedTask[]>

const SYSTEM_PROMPT =
  'You decompose a software requirement into a small dependency-aware task list for AI agents ' +
  'to execute. You may explore the repository (Read/Grep/Glob) to ground the tasks in the real ' +
  'code. Output ONLY a JSON array — no prose, no code fences. Each element: {"title": short ' +
  'human label, "prompt": the full self-contained instruction an agent will execute, ' +
  '"dependsOn": array of ZERO-BASED INDICES of earlier tasks that must finish first ([] if ' +
  'none)}. When a list of available agent types is supplied, an element may also carry ' +
  '"agentType": the NAME of the best-suited type from that list (omit it for the default ' +
  'agent). Order tasks so dependencies always point at earlier elements. Prefer 2-6 tasks; ' +
  'independent tasks should have no dependency on each other so they can run in parallel.'

/** Read-only tools the decomposer may use to explore the repo. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Valid dependencies for the task at `index`: integer indices of EARLIER
 * tasks, deduplicated. Anything else (self, forward, fractional, non-numeric)
 * is dropped — pointing only backwards makes the graph a DAG by construction. */
function backwardDeps(raw: unknown, index: number): number[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const deps = raw.filter(
    (dep): dep is number =>
      typeof dep === 'number' && Number.isInteger(dep) && dep >= 0 && dep < index,
  )
  return [...new Set(deps)]
}

/** Resolve the model's "agentType" (a NAME from the supplied roster) to a
 * saved type's id — matched case-insensitively; anything unknown means the
 * default agent. */
function resolveAgentType(raw: unknown, types: AgentType[]): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const wanted = raw.trim().toLowerCase()
  return types.find((type) => type.name.trim().toLowerCase() === wanted)?.id
}

/** Pull the task array out of the model's reply — strip any code fence, take
 * from the first `[` to the last `]`, and validate each element. Null when the
 * reply doesn't contain a usable array (the caller falls back). */
export function extractTaskArray(text: string, types: AgentType[] = []): DecomposedTask[] | null {
  const fenced = /```(?:[a-zA-Z]*)?\n?([\s\S]*?)```/.exec(text)
  const body = (fenced === null ? text : fenced[1]).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end <= start) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null
  }
  const tasks: DecomposedTask[] = []
  for (const [index, item] of parsed.entries()) {
    if (!isRecord(item) || typeof item['title'] !== 'string' || item['title'].trim() === '') {
      return null
    }
    const title = item['title'].trim()
    // A missing prompt falls back to the title — a thin task, not a lost one.
    const prompt =
      typeof item['prompt'] === 'string' && item['prompt'].trim() !== ''
        ? item['prompt'].trim()
        : title
    const agentTypeId = resolveAgentType(item['agentType'], types)
    tasks.push({
      title,
      prompt,
      dependsOn: backwardDeps(item['dependsOn'], index),
      ...(agentTypeId === undefined ? {} : { agentTypeId }),
    })
  }
  return tasks
}

/** The whole requirement as a single task — the graceful floor when the model's
 * reply can't be parsed. The plan still works; it just isn't decomposed. */
export function fallbackTasks(requirement: string): DecomposedTask[] {
  return [{ title: 'Implement the requirement', prompt: requirement, dependsOn: [] }]
}

/** The roster of saved agent types handed to the model, one per line, so it
 * can match each task to a role by NAME. Instructions are the role's meaning,
 * so their first line rides along as the description. */
function typeRoster(types: AgentType[]): string {
  if (types.length === 0) {
    return ''
  }
  const lines = types.map((type) => {
    const description = type.instructions.split('\n')[0]
    return `- ${type.name}${description === '' ? '' : `: ${description}`}`
  })
  return `\n\nAvailable agent types:\n${lines.join('\n')}`
}

/** Build a PlanDecomposer over the injected SDK query. The model may explore
 * the repo read-only to ground its decomposition, but can't touch anything.
 * The type roster rides in the user prompt (volatile content last — the
 * system prompt stays stable for the cache). */
export function decomposePlanWith(query: ClaudeQuery): PlanDecomposer {
  return async (requirement, types) => {
    const stream = query({
      prompt: `Requirement:\n${requirement}${typeRoster(types)}\n\nReturn the task array only.`,
      options: {
        cwd: process.cwd(),
        systemPrompt: SYSTEM_PROMPT,
        canUseTool: (toolName, input) =>
          Promise.resolve(
            READ_ONLY_TOOLS.has(toolName)
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'Planning is read-only.' },
          ),
      },
    })
    let text = ''
    for await (const message of stream) {
      text += assistantText(message)
    }
    return extractTaskArray(text, types) ?? fallbackTasks(requirement)
  }
}

/** The deterministic, no-network decomposition the Playwright e2e (and the
 * bootstrap test) drive under AGENTINATOR_MOCK_TASKS: a three-task chain whose
 * frontier starts at Scaffold and advances as each agent finishes. The first
 * saved type (if any) is suggested for Verify — a stand-in for the real
 * decomposer's role matching. */
export function scriptedDecomposer(
  requirement: string,
  types: AgentType[],
): Promise<DecomposedTask[]> {
  const verifyType = types[0]?.id
  return Promise.resolve([
    { title: 'Scaffold', prompt: `Set up the groundwork for: ${requirement}`, dependsOn: [] },
    { title: 'Implement', prompt: `Implement: ${requirement}`, dependsOn: [0] },
    {
      title: 'Verify',
      prompt: `Verify the result of: ${requirement}`,
      dependsOn: [1],
      ...(verifyType === undefined ? {} : { agentTypeId: verifyType }),
    },
  ])
}
