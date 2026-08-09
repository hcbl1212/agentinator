import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the built Electron app (out/) via Playwright's
 * Electron support. They run the real main process + preload + renderer with a
 * deterministic mock provider (AGENTINATOR_MOCK_TASKS) so no network is needed
 * — guarding the launch → stream critical path.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
})
