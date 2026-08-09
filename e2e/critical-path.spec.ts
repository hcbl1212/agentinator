import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'

/**
 * The critical path: type a task, hit Enter, and see it in the timeline scoped
 * to a newly selected agent. This is the flow that broke when a selection race
 * cleared the just-launched agent; the e2e drives the real main + renderer with
 * the deterministic mock provider (no network) so it can't silently regress.
 */
test('launching a task shows it in the timeline, scoped to the new agent', async () => {
  // A throwaway user-data dir keeps each run's event log clean.
  const userData = mkdtempSync(join(tmpdir(), 'agentinator-e2e-'))
  const app = await electron.launch({
    args: ['out/main/entry.js', `--user-data-dir=${userData}`],
    env: { ...process.env, AGENTINATOR_MOCK_TASKS: '1' },
  })
  const page = await app.firstWindow()

  try {
    // Land on the empty stream with the composer ready.
    await expect(page.getByText(/Select an agent, or start a task below/)).toBeVisible()
    await expect(page.getByText('No agents yet.')).toBeVisible()

    const prompt = page.getByRole('textbox', { name: 'Task for the agent' })
    await prompt.fill('hello there')
    await prompt.press('Enter')

    // The launched task appears in the timeline (scoped to its agent)…
    const stream = page.getByRole('region', { name: 'Conversation' })
    await expect(stream.getByText(/session started · hello there/)).toBeVisible()
    await expect(stream.getByText('hello there', { exact: true })).toBeVisible()
    // …and the agent shows in the rail, highlighted (selection stuck).
    const agent = page.getByRole('button', { name: /hello there/ })
    await expect(agent).toBeVisible()
    await expect(agent).toHaveAttribute('aria-pressed', 'true')
    // The empty-stream prompt is gone — the stream scoped to the agent.
    await expect(page.getByText(/Select an agent, or start a task below/)).toHaveCount(0)
  } finally {
    await app.close()
  }
})
