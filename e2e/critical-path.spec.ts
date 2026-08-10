import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

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
