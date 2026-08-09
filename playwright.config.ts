import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the built Electron app (out/) via Playwright's
 * Electron support. They run the real main process + preload + renderer with a
 * deterministic mock provider (AGENTINATOR_MOCK_TASKS) so no network is needed
 * — guarding the launch → stream critical path.
 */
export default defineConfig({
  testDir: './e2e',
  // Each test spins up its own Electron app against a throwaway user-data dir,
  // so they share no state — run them in parallel to cut wall-clock. Electron
  // launch is largely I/O wait, so oversubscribing the cores pays off.
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  reporter: 'list',
})
