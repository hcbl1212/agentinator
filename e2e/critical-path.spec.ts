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
async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'agentinator-e2e-'))
  const app = await electron.launch({
    args: ['out/main/entry.js', `--user-data-dir=${userData}`],
    env: { ...process.env, AGENTINATOR_MOCK_TASKS: '1' },
  })
  const page = await app.firstWindow()
  return { app, page }
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

    const agent = page.getByRole('button', { name: /hello there/ })
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
    await page.getByRole('button', { name: /task alpha/ }).click()
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
    await expect(stream.getByText('awaiting your reply')).toBeVisible()

    const reply = page.getByRole('textbox', { name: 'Reply to the agent' })
    await reply.fill('are you there')
    await reply.press('Enter')

    await expect(stream.getByText('are you there', { exact: true })).toBeVisible()
    await expect(stream.getByText('Echo: are you there')).toBeVisible()
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
    await expect(page.getByRole('button', { name: /some task/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const reply = page.getByRole('textbox', { name: 'Reply to the agent' })
    await reply.fill('/clear')
    await reply.press('Enter')

    // Selection dropped → back to the empty stream and a task prompt.
    await expect(page.getByText(/Select an agent, or start a task below/)).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Task for the agent' })).toBeVisible()
    await expect(page.getByRole('button', { name: /some task/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  } finally {
    await app.close()
  }
})

test('a low session budget stops the agent when its cost exceeds the cap', async () => {
  const { app, page } = await launchApp()
  const stream = page.getByRole('region', { name: 'Conversation' })
  try {
    // Set a session cap below the provider's reported cost ($0.10).
    await page.getByRole('button', { name: /session \$/ }).click()
    const cap = page.getByRole('spinbutton', { name: 'Session budget in dollars' })
    await cap.fill('0.05')
    await cap.press('Enter')
    await expect(page.getByRole('button', { name: /\/ \$0\.05/ })).toBeVisible()
    await page.getByRole('button', { name: 'Close budgets' }).click()

    await launchTask(page, 'spend some money')

    await expect(stream.getByText(/budget exceeded/)).toBeVisible()
    await expect(stream.getByText('session cancelled')).toBeVisible()
  } finally {
    await app.close()
  }
})
