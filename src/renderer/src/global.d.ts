import type { AgentinatorBridge } from '../../shared/bridge'

declare global {
  interface Window {
    agentinator?: AgentinatorBridge
  }
}

export {}
