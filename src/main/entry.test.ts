import { describe, expect, it, vi } from 'vitest'

const { mockBootstrap } = vi.hoisted(() => ({
  mockBootstrap: vi.fn(() => Promise.resolve()),
}))

vi.mock('./index', () => ({ bootstrap: mockBootstrap }))

import './entry'

describe('main entry', () => {
  it('boots the app exactly once on import', () => {
    expect(mockBootstrap).toHaveBeenCalledOnce()
  })
})
