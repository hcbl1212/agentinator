import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * End-to-end guards for the launch → stream critical paths. They drive the
 * built app (real main + preload + renderer) with the deterministic mock
 * provider (AGENTINATOR_MOCK_TASKS, no network) so they can't silently
 * regress. Each test gets a throwaway user-data dir → a clean event log.
 */
async function launchApp(
  userData: string = mkdtempSync(join(tmpdir(), 'agentinator-e2e-')),
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  // Against the dev build (out/) by default, or the packaged .app binary when
  // AGENTINATOR_E2E_BINARY is set — the release pipeline's gate on the shipped
  // artifact. A reused user-data dir (passed in) keeps the event log across a
  // relaunch, so restart/resume can be tested.
  const binary = process.env['AGENTINATOR_E2E_BINARY']
  const launch = binary
    ? { executablePath: binary, args: [`--user-data-dir=${userData}`] }
    : { args: ['out/main/entry.js', `--user-data-dir=${userData}`] }
  const app = await electron.launch({
    ...launch,
    env: { ...process.env, AGENTINATOR_MOCK_TASKS: '1' },
  })
  const page = await app.firstWindow()
  return { app, page, userData }
}

async function launchTask(page: Page, text: string): Promise<void> {
  const prompt = page.getByRole('textbox', { name: 'Task for the agent' })
  await prompt.fill(text)
  await prompt.press('Enter')
}

/**
 * Scaffold a tiny Vite React app and serve it, so the component workbench has a
 * real dev server to render a single component through (bare `react` and the
 * `/src/...` import only resolve via a running Vite). Kept under the repo so its
 * imports resolve against the harness's own node_modules. The component logs on
 * mount — a signal the isolated render actually ran, visible in captured
 * console output even though the screenshot is opaque pixels to the test.
 */
async function startComponentFixture(): Promise<{
  server: ViteDevServer
  root: string
  url: string
}> {
  const root = mkdtempSync(join(process.cwd(), 'e2e', 'wb-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><body><div id="root"></div></body>')
  writeFileSync(
    join(root, 'src', 'Widget.tsx'),
    "import { useEffect } from 'react'\n" +
      'export function Widget() {\n' +
      "  useEffect(() => console.log('WIDGET_MOUNTED_OK'), [])\n" +
      '  return <p>Hello from the isolated Widget</p>\n' +
      '}\n',
  )
  writeFileSync(
    join(root, 'src', 'PreviewWrapper.tsx'),
    'export default function PreviewWrapper({ children }: { children?: unknown }) {\n' +
      '  return <div data-preview-wrapper>{children as never}</div>\n' +
      '}\n',
  )
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [react()],
    server: { port: 4319 },
    // Pre-bundle the mount deps at startup — including react-dom/client, which
    // the entry loads via a dynamic import (the React 19 mount path). Without
    // this, a cold optimize (fresh CI node_modules) races that import and it
    // 504s ("Failed to fetch dynamically imported module").
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client'] },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0] ?? ''
  // Warm the dep optimizer so the first harness capture isn't racing a cold
  // esbuild prebundle + full-reload during its settle window.
  await fetch(`${url}src/Widget.tsx`).catch(() => undefined)
  return { server, root, url }
}

test('launching a task shows it in the timeline, scoped to the new agent', async () => {
  const { app, page } = await launchApp()
  try {
    await expect(page.getByText(/Select an agent, or start a task below/)).toBeVisible()
    await expect(page.getByText('No agents yet.')).toBeVisible()

    await launchTask(page, 'hello there')

    const stream = page.getByRole('region', { name: 'Conversation' })
    await expect(stream.getByText(/session started · hello there/)).toBeVisible()
    await expect(stream.getByText('hello there', { exact: true })).toBeVisible()

    const agent = page.getByRole('button', { name: /^hello there/ })
    await expect(agent).toBeVisible()
    await expect(agent).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/Select an agent, or start a task below/)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('queues a task, then dispatches it to a new agent', async () => {
  const { app, page } = await launchApp()
  try {
    // Park a task in the backlog instead of launching it.
    await page.getByRole('textbox', { name: 'Task for the agent' }).fill('queued work')
    await page.getByRole('button', { name: 'Queue task' }).click()

    const queue = page.getByRole('region', { name: 'Task queue' })
    await expect(queue.getByText('queued work')).toBeVisible()
    // It's only in the queue — no agent yet.
    await expect(page.getByRole('button', { name: /^queued work/ })).toHaveCount(0)

    // Dispatch it → it becomes an agent in the rail and leaves the queue.
    await queue.getByRole('button', { name: 'Dispatch queued work' }).click()
    await expect(page.getByRole('button', { name: /^queued work/ })).toBeVisible()
    await expect(queue.getByText('queued work')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('running two agents and switching scopes the stream to each (focus-follows)', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    // First agent.
    await launchTask(page, 'task alpha')
    await expect(stream.getByText(/session started · task alpha/)).toBeVisible()

    // New agent → the composer resets to a fresh task prompt.
    await page.getByRole('button', { name: 'New agent' }).click()
    await expect(page.getByText(/Select an agent, or start a task below/)).toBeVisible()

    // Second agent — the stream scopes to it, hiding the first.
    await launchTask(page, 'task beta')
    await expect(stream.getByText(/session started · task beta/)).toBeVisible()
    await expect(stream.getByText(/session started · task alpha/)).toHaveCount(0)

    // Switch back to the first agent — the stream follows the selection.
    await page.getByRole('button', { name: /^task alpha/ }).click()
    await expect(stream.getByText(/session started · task alpha/)).toBeVisible()
    await expect(stream.getByText(/session started · task beta/)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('replying to an idle agent shows the follow-up and its echo', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    await launchTask(page, 'first task')
    // The turn's output settles the agent (idle is internal state, not a line).
    await expect(stream.getByText('Ready.')).toBeVisible()

    const reply = page.getByRole('textbox', { name: 'Reply to the agent' })
    await reply.fill('are you there')
    await reply.press('Enter')

    await expect(stream.getByText('are you there', { exact: true })).toBeVisible()
    await expect(stream.getByText('Echo: are you there')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the timeline renders thinking, tool calls, and their results', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    await launchTask(page, 'do some work')

    // Events the enriched provider mirrors from a real turn now render E2E.
    await expect(stream.getByText(/thinking · Planning the change/)).toBeVisible()
    await expect(stream.getByText(/read README\.md/)).toBeVisible()
    await expect(stream.getByText('read 12 lines')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the rail shows the agent’s model and billing mode', async () => {
  const { app, page } = await launchApp()
  try {
    await launchTask(page, 'a task')

    const rail = page.getByRole('complementary', { name: 'Agents' })
    await expect(rail.getByText('E2e · model-1')).toBeVisible()
    await expect(rail.getByText('plan')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an agent question shows an answerable card, and answering echoes', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    await launchTask(page, 'please ask a question')

    const card = page.getByLabel('Agent question')
    await expect(card.getByText('Which approach?')).toBeVisible()
    await card.getByRole('button', { name: 'Fast' }).click()

    // The chosen option is sent as the reply and the provider echoes it.
    await expect(stream.getByText('Echo: Fast')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a session survives an app restart and reopens on reply', async () => {
  const first = await launchApp()
  const stream = first.page.getByRole('region', { name: 'Conversation' })
  try {
    await launchTask(first.page, 'resumable work')
    await expect(stream.getByText('Ready.')).toBeVisible()
  } finally {
    await first.app.close()
  }

  // Relaunch against the SAME user-data dir — the event log persists.
  const { app, page } = await launchApp(first.userData)
  try {
    // The agent is restored from the log; selecting it enters reply mode.
    await page.getByRole('button', { name: /^resumable work/ }).click()
    const reply = page.getByRole('textbox', { name: 'Reply to the agent' })
    await reply.fill('are you back')
    await reply.press('Enter')

    // Reopened via the provider's resume path → the reply echoes.
    await expect(
      page.getByRole('region', { name: 'Conversation' }).getByText('Echo: are you back'),
    ).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the inbox surfaces an agent that needs you and jumps to it', async () => {
  const { app, page } = await launchApp()
  try {
    await launchTask(page, 'needs approval to write')

    // The status-bar inbox chip counts the pending approval.
    const chip = page.getByRole('button', { name: 'inbox 1' })
    await expect(chip).toBeVisible()
    await chip.click()

    // The triage panel lists it; clicking an item jumps to the agent and closes.
    const panel = page.getByRole('dialog', { name: 'Attention inbox' })
    await expect(panel.getByText(/wants to run/i)).toBeVisible()
    await panel.getByRole('button', { name: /Go to/ }).click()
    await expect(panel).toHaveCount(0)

    // Handling the approval empties the inbox.
    await page.getByLabel('Pending approvals').getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('button', { name: 'inbox 1' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'inbox' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an approval card gates a write; approving lets it proceed', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    // The provider requests a write approval when the prompt mentions it.
    await launchTask(page, 'needs approval to write')

    const approvals = page.getByLabel('Pending approvals')
    await expect(approvals.getByText(/write/)).toBeVisible()

    await approvals.getByRole('button', { name: 'Approve' }).click()

    await expect(stream.getByText('Write approved.')).toBeVisible()
    await expect(approvals.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('denying a write shows a grace countdown that Undo reverses', async () => {
  const { app, page } = await launchApp()
  try {
    await launchTask(page, 'needs approval to write')

    const approvals = page.getByLabel('Pending approvals')
    await approvals.getByRole('button', { name: 'Deny' }).click()

    // A grace countdown lets you take it back before the denial commits.
    await expect(approvals.getByText(/Denying ·/)).toBeVisible()
    await approvals.getByRole('button', { name: 'Undo' }).click()

    // Back to a live approval you can now approve.
    await expect(approvals.getByRole('button', { name: 'Approve' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the Diff tab shows the selected agent’s changes', async () => {
  const { app, page } = await launchApp()
  try {
    await launchTask(page, 'make a change')

    await page.getByRole('tab', { name: 'Diff' }).click()
    const diff = page.getByRole('region', { name: 'Diff' })
    await expect(diff.getByText('src/demo/e2e.ts')).toBeVisible()
    await expect(diff.getByText('+2')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('/clear drops the agent and returns to a fresh task prompt', async () => {
  const { app, page } = await launchApp()
  try {
    await launchTask(page, 'some task')
    await expect(page.getByRole('button', { name: /^some task/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const reply = page.getByRole('textbox', { name: 'Reply to the agent' })
    await reply.fill('/clear')
    await reply.press('Enter')

    // Selection dropped → back to the empty stream and a task prompt.
    await expect(page.getByText(/Select an agent, or start a task below/)).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Task for the agent' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^some task/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  } finally {
    await app.close()
  }
})

test('removing an agent takes it out of the rail', async () => {
  const { app, page } = await launchApp()
  try {
    await launchTask(page, 'throwaway task')
    await expect(page.getByRole('button', { name: /^throwaway task/ })).toBeVisible()

    await page.getByRole('button', { name: 'Remove throwaway task' }).click()

    // Gone from the fleet, and the stream returns to the empty prompt.
    await expect(page.getByRole('button', { name: /^throwaway task/ })).toHaveCount(0)
    await expect(page.getByText('No agents yet.')).toBeVisible()
    await expect(page.getByText(/Select an agent, or start a task below/)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the Preview tab captures a real screenshot of the sample app', async () => {
  const { app, page } = await launchApp()
  try {
    // A selected agent scopes the preview; the mock task creates one.
    await launchTask(page, 'look at the app')

    await page.getByRole('tab', { name: 'Preview' }).click()
    const preview = page.getByRole('region', { name: 'App preview' })
    await preview.getByRole('button', { name: 'Capture' }).click()

    // The real Electron capturePage → artifact store → base64 round-trip lands a
    // PNG data URL in the pane (proves the offscreen capture actually paints).
    const shot = preview.getByRole('img', { name: /screenshot of the target app/i })
    await expect(shot).toBeVisible()
    await expect(shot).toHaveAttribute('src', /^data:image\/png;base64,/)

    // The sample logs on load — real console capture surfaces it in the pane.
    const console = preview.getByRole('region', { name: 'App console' })
    await expect(console).toContainText('demo warning')
  } finally {
    await app.close()
  }
})

test('pointing at a spot on the preview sends it to the agent', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    await launchTask(page, 'watch the app')
    await page.getByRole('tab', { name: 'Preview' }).click()
    const preview = page.getByRole('region', { name: 'App preview' })
    await preview.getByRole('button', { name: 'Capture' }).click()
    await expect(preview.getByRole('img', { name: /screenshot of the target app/i })).toBeVisible()

    // Click a spot on the screenshot, annotate it, and send it to the agent.
    await preview
      .getByRole('button', { name: /Point at the app/i })
      .click({ position: { x: 30, y: 20 } })
    await preview.getByRole('textbox', { name: 'Note about the marked spot' }).fill('align this')
    await preview.getByRole('button', { name: 'Send to agent' }).click()

    // The annotation reaches the agent as a message with the screenshot attached
    // (anchored so it doesn't also match the provider's echo of it).
    await expect(stream.getByText(/^Pointing at the app preview.*align this/)).toBeVisible()
    await expect(stream.getByText(/\[\+1 image\]/)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the Preview tab renders a single component in isolation through a dev server', async () => {
  const { server, root, url } = await startComponentFixture()
  const { app, page } = await launchApp()
  try {
    // A selected agent scopes the preview; the mock task creates one.
    await launchTask(page, 'isolate a component')
    await page.getByRole('tab', { name: 'Preview' }).click()
    const preview = page.getByRole('region', { name: 'App preview' })

    // Point the harness at the fixture dev server.
    await preview.getByRole('textbox', { name: 'Preview target URL' }).fill(url)
    await preview.getByRole('button', { name: 'Set' }).click()

    // Pin the component + its context wrapper (the setup block is open by default).
    await preview.getByRole('textbox', { name: 'Component app root' }).fill(root)
    await preview.getByRole('textbox', { name: 'Component file' }).fill('src/Widget.tsx')
    await preview.getByRole('textbox', { name: 'Wrapper file' }).fill('src/PreviewWrapper.tsx')
    // Give a cold-start Vite transform ample room before the shot (also exercises
    // the configurable settle delay end-to-end).
    await preview
      .getByRole('spinbutton', { name: 'Capture settle delay in milliseconds' })
      .fill('3000')
    await preview.getByRole('button', { name: 'Pin' }).click()

    await preview.getByRole('button', { name: 'Capture' }).click()

    // A PNG lands — the offscreen capture of the isolated entry actually painted.
    const shot = preview.getByRole('img', { name: /screenshot of the target app/i })
    await expect(shot).toHaveAttribute('src', /^data:image\/png;base64,/)
    // And the component's mount effect ran: proof it truly rendered in isolation
    // through the app's own Vite (a blank or failed mount wouldn't log this).
    await expect(preview.getByRole('region', { name: 'App console' })).toContainText(
      'WIDGET_MOUNTED_OK',
    )
  } finally {
    await app.close()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a low session budget stops the agent when its cost exceeds the cap', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    // Set a session cap below the provider's reported cost ($0.10).
    await page.getByRole('button', { name: 'budgets' }).click()
    const cap = page.getByRole('spinbutton', { name: 'Session budget in dollars' })
    await cap.fill('0.05')
    await cap.press('Enter')
    await expect(cap).toHaveValue('0.05')
    await page.getByRole('button', { name: 'Close budgets' }).click()

    await launchTask(page, 'spend some money')

    await expect(stream.getByText(/budget exceeded/)).toBeVisible()
    await expect(stream.getByText('session cancelled')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('planning a requirement builds a task tree whose frontier advances as agents finish', async () => {
  const { app, page } = await launchApp()
  try {
    // Decompose a requirement (the scripted decomposer under mock tasks).
    const planner = page.getByRole('region', { name: 'Planner' })
    const requirement = planner.getByRole('textbox', { name: 'Requirement to plan' })
    await requirement.fill('Add a settings page')
    await planner.getByRole('button', { name: 'Plan' }).click()

    // The task tree: only the first task is on the ready frontier.
    await expect(planner.getByLabel('Scaffold — ready')).toBeVisible()
    await expect(planner.getByLabel('Implement — blocked · after Scaffold')).toBeVisible()
    await expect(planner.getByLabel('Verify — blocked · after Implement')).toBeVisible()
    await expect(planner.getByRole('button', { name: 'Dispatch Implement' })).toHaveCount(0)

    // Dispatch the frontier → a real agent appears in the rail, selected.
    await planner.getByRole('button', { name: 'Dispatch Scaffold' }).click()
    await expect(page.getByRole('button', { name: /^Set up the groundwork/ })).toBeVisible()

    // The scripted agent finishes → the task completes and unlocks Implement.
    await expect(
      planner.getByRole('button', { name: 'Scaffold — done — select its agent' }),
    ).toBeVisible()
    await expect(planner.getByRole('button', { name: 'Dispatch Implement' })).toBeVisible()

    // The dispatch selected the agent (timeline showing) — the stream toggle
    // flips back to the DAG and returns to the same agent's timeline.
    await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.getByRole('tab', { name: 'Plan' }).click()
    await expect(page.getByRole('region', { name: 'Plan canvas' })).toBeVisible()
    await page.getByRole('tab', { name: 'Timeline' }).click()
    await expect(page.getByRole('region', { name: 'Plan canvas' })).toHaveCount(0)
    await expect(page.getByText(/session started · Set up the groundwork/)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the plan canvas fills the idle stream slot and edits dependency edges', async () => {
  const { app, page } = await launchApp()
  try {
    const planner = page.getByRole('region', { name: 'Planner' })
    await planner.getByRole('textbox', { name: 'Requirement to plan' }).fill('Wire up billing')
    await planner.getByRole('button', { name: 'Plan' }).click()
    await expect(planner.getByLabel('Scaffold — ready')).toBeVisible()

    // With no agent selected, the canvas takes the centre stream slot by
    // itself — the idle "select an agent" prompt gives way to the graph.
    const canvas = page.getByRole('region', { name: 'Plan canvas' })
    await expect(page.getByText(/Select an agent, or start a task below/)).toHaveCount(0)
    await expect(canvas.getByRole('button', { name: 'Trace Verify' })).toBeVisible()
    await expect(
      canvas.getByRole('button', { name: 'Remove dependency Implement → Verify' }),
    ).toBeVisible()

    // Draw an edge: Verify now also waits on Scaffold directly.
    await canvas.getByRole('button', { name: 'Link from Scaffold' }).click()
    await canvas.getByRole('button', { name: 'Make Verify depend on Scaffold' }).click()
    await expect(
      canvas.getByRole('button', { name: 'Remove dependency Scaffold → Verify' }),
    ).toBeVisible()

    // Erase Implement's own gate instead — it joins the ready frontier.
    await canvas.getByRole('button', { name: 'Remove dependency Scaffold → Implement' }).click()
    await expect(canvas.getByRole('button', { name: 'Dispatch Implement' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a plan task carries an agent type: suggested, editable, frozen at dispatch', async () => {
  const { app, page } = await launchApp()
  try {
    // Save a "Reviewer" role via the composer's Manage panel.
    await page.getByRole('button', { name: 'Manage' }).click()
    await page.getByRole('textbox', { name: 'Agent type name' }).fill('Reviewer')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Manage' }).click()

    // Plan — the scripted decomposer suggests the saved role for Verify,
    // visible as a badge on its node and pre-selected on its detail card.
    const planner = page.getByRole('region', { name: 'Planner' })
    await planner.getByRole('textbox', { name: 'Requirement to plan' }).fill('Harden auth')
    await planner.getByRole('button', { name: 'Plan' }).click()
    const canvas = page.getByRole('region', { name: 'Plan canvas' })
    await expect(canvas.getByTitle('Role: Reviewer')).toBeVisible()
    await canvas.getByRole('button', { name: 'Trace Verify' }).click()
    await expect(canvas.getByLabel('Agent type for Verify').locator('option:checked')).toHaveText(
      'Reviewer',
    )

    // Reassign Scaffold through ITS detail card — the one role picker.
    await canvas.getByRole('button', { name: 'Trace Scaffold' }).click()
    await canvas.getByLabel('Agent type for Scaffold').selectOption({ label: 'Reviewer' })
    await expect(canvas.getByLabel('Agent type for Scaffold').locator('option:checked')).toHaveText(
      'Reviewer',
    )

    // Dispatch freezes the choice — the new agent takes the centre pane, so
    // reopen the plan and its card: the picker has given way to read-only meta.
    await canvas.getByRole('button', { name: 'Dispatch Scaffold' }).click()
    await planner.getByRole('button', { name: 'Select plan Harden auth' }).click()
    await canvas.getByRole('button', { name: 'Trace Scaffold' }).click()
    await expect(canvas.getByLabel('Agent type for Scaffold')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Task details: Scaffold' })).toContainText(
      'Reviewer',
    )
  } finally {
    await app.close()
  }
})

test('clicking a task opens its editable brief, and the edit rides the dispatch', async () => {
  const { app, page } = await launchApp()
  try {
    const planner = page.getByRole('region', { name: 'Planner' })
    await planner.getByRole('textbox', { name: 'Requirement to plan' }).fill('Ship dark mode')
    await planner.getByRole('button', { name: 'Plan' }).click()

    // Click a node → its detail card shows the exact brief the agent will
    // run, in an editor (the task hasn't launched yet).
    const canvas = page.getByRole('region', { name: 'Plan canvas' })
    await canvas.getByRole('button', { name: 'Trace Scaffold' }).click()
    const detail = page.getByRole('region', { name: 'Task details: Scaffold' })
    const brief = detail.getByRole('textbox', { name: 'Brief for Scaffold' })
    await expect(brief).toHaveValue('Set up the groundwork for: Ship dark mode')
    await expect(detail.getByRole('button', { name: 'Save brief' })).toBeDisabled()

    // Rewrite the brief and save — the edit lands via the event log…
    await brief.fill('Set up the groundwork for: Ship dark mode. Include storybook.')
    await detail.getByRole('button', { name: 'Save brief' }).click()
    await expect(detail.getByRole('button', { name: 'Save brief' })).toBeDisabled()

    // …and IS the prompt at dispatch: the agent's opening message carries it.
    await canvas.getByRole('button', { name: 'Dispatch Scaffold' }).click()
    const stream = page.getByRole('region', { name: 'Conversation' })
    await expect(stream.getByText(/Include storybook/)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a plan task can run as a full pipeline from the canvas', async () => {
  const { app, page } = await launchApp()
  try {
    const planner = page.getByRole('region', { name: 'Planner' })
    await planner.getByRole('textbox', { name: 'Requirement to plan' }).fill('Encrypt PHI at rest')
    await planner.getByRole('button', { name: 'Plan' }).click()

    // Run the frontier task as a Plan → Implement → Review pipeline.
    const canvas = page.getByRole('region', { name: 'Plan canvas' })
    await canvas.getByRole('button', { name: 'Pipeline Scaffold' }).click()

    // The pipeline appears in the rail under the task's brief-derived title…
    const pipelines = page.getByRole('region', { name: 'Pipelines' })
    await expect(
      pipelines.getByText(/Set up the groundwork for: Encrypt PHI at rest/),
    ).toBeVisible()

    // …and the node rides it: running, with its card naming the mode.
    await expect(canvas.getByTitle('Scaffold — running')).toBeVisible()
    await canvas.getByRole('button', { name: 'Trace Scaffold' }).click()
    await expect(page.getByRole('region', { name: 'Task details: Scaffold' })).toContainText(
      'via pipeline',
    )

    // The pipeline's title opens the review workbench in the centre: stage
    // reasoning + the gate, with a Continue that advances it right there.
    await pipelines.getByRole('button', { name: /Review pipeline Set up the groundwork/ }).click()
    const bench = page.getByRole('region', { name: 'Review workbench' })
    await expect(bench.getByRole('region', { name: 'Stage: Plan' })).toBeVisible()
    await bench.getByRole('button', { name: 'Continue → Implement' }).click()
    // The mock stage may already have finished by the time we look.
    await expect(pipelines.getByLabel(/Implement — (running|done)/)).toBeVisible()

    // Close returns the centre pane to the plan canvas.
    await bench.getByRole('button', { name: 'Close review' }).click()
    await expect(page.getByRole('region', { name: 'Plan canvas' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('expanding a task splices its sub-plan into place on the canvas', async () => {
  const { app, page } = await launchApp()
  try {
    const planner = page.getByRole('region', { name: 'Planner' })
    await planner.getByRole('textbox', { name: 'Requirement to plan' }).fill('Build the data layer')
    await planner.getByRole('button', { name: 'Plan' }).click()

    // Expand the middle task from its card: the scripted decomposer turns its
    // brief into a Scaffold → Implement → Verify sub-chain in place.
    const canvas = page.getByRole('region', { name: 'Plan canvas' })
    await canvas.getByRole('button', { name: 'Trace Implement' }).click()
    await page.getByRole('button', { name: 'Expand Implement into sub-tasks' }).click()

    // Five nodes now: two Scaffolds and two Verifys (parent + sub), the card
    // for the vanished task closed, and the tail rewired through the leaf.
    await expect(canvas.getByRole('button', { name: 'Trace Scaffold' })).toHaveCount(2)
    await expect(canvas.getByRole('button', { name: 'Trace Verify' })).toHaveCount(2)
    await expect(page.getByRole('region', { name: 'Task details: Implement' })).toHaveCount(0)
    await expect(
      canvas.getByRole('button', { name: 'Remove dependency Verify → Verify' }),
    ).toBeVisible()
  } finally {
    await app.close()
  }
})

test('promoting a stage’s plan replaces the pipelined task with its sub-plan', async () => {
  const { app, page } = await launchApp()
  try {
    const planner = page.getByRole('region', { name: 'Planner' })
    await planner.getByRole('textbox', { name: 'Requirement to plan' }).fill('Promote me')
    await planner.getByRole('button', { name: 'Plan' }).click()

    // Run Scaffold as a pipeline, open its workbench, and promote the Plan
    // stage's written output instead of continuing.
    const canvas = page.getByRole('region', { name: 'Plan canvas' })
    await canvas.getByRole('button', { name: 'Pipeline Scaffold' }).click()
    const pipelines = page.getByRole('region', { name: 'Pipelines' })
    await pipelines.getByRole('button', { name: /Review pipeline Set up the groundwork/ }).click()
    await page.getByRole('button', { name: 'Promote Plan output to plan tasks' }).click()

    // Back on the canvas: Scaffold is gone, its scripted sub-chain stands in
    // its place, and the superseded pipeline left the rail.
    await expect(canvas.getByRole('button', { name: 'Trace Implement' })).toHaveCount(2)
    await expect(canvas.getByRole('button', { name: 'Trace Verify' })).toHaveCount(2)
    await expect(pipelines.getByText(/No pipelines yet/)).toBeVisible()
  } finally {
    await app.close()
  }
})
