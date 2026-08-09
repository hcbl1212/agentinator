import { tmpdir } from 'node:os'

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType } from '../../shared/events'
import { createClaudeProvider } from './claude'
import type { ClaudeQuery, SdkCreateServer, SdkTool } from './claude'

// A valid 1×1 PNG — enough for the SDK to accept and forward an image result.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/**
 * Opt-in smoke test that drives REAL Claude through the real Agent SDK MCP
 * machinery — the one thing unit tests can't prove: that our mcpServers /
 * allowedTools wiring makes the agent actually call the app-capture tool and
 * that the SDK accepts the image result. Capture is faked (Electron's window
 * API isn't available in a plain node test), so this checks the wiring, not the
 * pixels. Skipped unless CLAUDE_SMOKE is set:
 *
 *   npm run smoke:preview
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('preview vision (live smoke)', () => {
  it(
    'lets the agent call the capture tool and take the image result',
    { timeout: 180_000 },
    async () => {
      const capture = vi.fn(() => Promise.resolve({ base64: TINY_PNG, mediaType: 'image/png' }))
      const provider = createClaudeProvider(query as unknown as ClaudeQuery, undefined, {
        capture,
        tool: tool as unknown as SdkTool,
        createSdkMcpServer: createSdkMcpServer as unknown as SdkCreateServer,
      })
      const events: Array<{ type: EventType; payload: EventPayloads[EventType] }> = []

      let finish: () => void = () => undefined
      // The turn ending (session.idle) is the signal — a Claude session stays
      // open for follow-ups and only ends on cancel, so we cancel to close it.
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })

      const handle = provider.startSession(
        {
          sessionId: 'session_preview_smoke',
          workspaceId: 'workspace_smoke',
          agentId: 'agent_smoke',
          title: 'Preview smoke test',
          prompt:
            'Call the capture_app tool once to look at the app, then reply with exactly: LOOKED',
          cwd: tmpdir(),
        },
        (type, payload) => {
          events.push({ type, payload })
          if (type === 'session.idle') {
            finish()
          }
        },
      )
      await done
      await handle.cancel()

      console.log('normalized events:', events.map((event) => event.type).join(' → '))

      const called = events
        .filter((event) => event.type === 'tool.called')
        .map((event) => (event.payload as EventPayloads['tool.called']).tool)
      expect(called).toContain('mcp__preview__capture_app')
      expect(capture).toHaveBeenCalledWith('session_preview_smoke')
    },
  )
})
