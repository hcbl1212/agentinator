import { assistantText } from './componentInference'
import type { ClaudeQuery } from './providers/claude'

/** One task as the decomposition model proposes it: dependencies are indices
 * into the same array (earlier tasks only), mapped to stable taskIds when the
 * plan is created. */
export interface DecomposedTask {
  title: string
  prompt: string
  dependsOn: number[]
}

/** Breaks a requirement into a dependency-aware task list — the AI behind the
 * planner's "Plan" button. Injected so callers stay testable without a live
 * model. */
export type PlanDecomposer = (requirement: string) => Promise<DecomposedTask[]>

const SYSTEM_PROMPT =
  'You decompose a software requirement into a small dependency-aware task list for AI agents ' +
  'to execute. You may explore the repository (Read/Grep/Glob) to ground the tasks in the real ' +
  'code. Output ONLY a JSON array — no prose, no code fences. Each element: {"title": short ' +
  'human label, "prompt": the full self-contained instruction an agent will execute, ' +
  '"dependsOn": array of ZERO-BASED INDICES of earlier tasks that must finish first ([] if ' +
  'none)}. Order tasks so dependencies always point at earlier elements. Prefer 2-6 tasks; ' +
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

/** Pull the task array out of the model's reply — strip any code fence, take
 * from the first `[` to the last `]`, and validate each element. Null when the
 * reply doesn't contain a usable array (the caller falls back). */
export function extractTaskArray(text: string): DecomposedTask[] | null {
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
    tasks.push({ title, prompt, dependsOn: backwardDeps(item['dependsOn'], index) })
  }
  return tasks
}

/** The whole requirement as a single task — the graceful floor when the model's
 * reply can't be parsed. The plan still works; it just isn't decomposed. */
export function fallbackTasks(requirement: string): DecomposedTask[] {
  return [{ title: 'Implement the requirement', prompt: requirement, dependsOn: [] }]
}

/** Build a PlanDecomposer over the injected SDK query. The model may explore
 * the repo read-only to ground its decomposition, but can't touch anything. */
export function decomposePlanWith(query: ClaudeQuery): PlanDecomposer {
  return async (requirement) => {
    const stream = query({
      prompt: `Requirement:\n${requirement}\n\nReturn the task array only.`,
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
    return extractTaskArray(text) ?? fallbackTasks(requirement)
  }
}

/** The deterministic, no-network decomposition the Playwright e2e (and the
 * bootstrap test) drive under AGENTINATOR_MOCK_TASKS: a three-task chain whose
 * frontier starts at Scaffold and advances as each agent finishes. */
export function scriptedDecomposer(requirement: string): Promise<DecomposedTask[]> {
  return Promise.resolve([
    { title: 'Scaffold', prompt: `Set up the groundwork for: ${requirement}`, dependsOn: [] },
    { title: 'Implement', prompt: `Implement: ${requirement}`, dependsOn: [0] },
    { title: 'Verify', prompt: `Verify the result of: ${requirement}`, dependsOn: [1] },
  ])
}
