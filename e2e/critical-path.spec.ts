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
