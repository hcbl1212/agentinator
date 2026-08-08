// @vitest-environment jsdom
import { waitFor } from '@testing-library/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = ''
})

describe('renderer entry', () => {
  it('mounts the app into #root when it exists', async () => {
    document.body.innerHTML = '<div id="root"></div>'

    await import('./main')

    await waitFor(() => {
      expect(document.querySelector('.cockpit')).not.toBeNull()
    })
  })

  it('does nothing when #root is absent', async () => {
    await import('./main')

    expect(document.querySelector('.cockpit')).toBeNull()
  })
})
