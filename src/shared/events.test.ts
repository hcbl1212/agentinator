import { describe, expect, it } from 'vitest'

import { ENTITY_KINDS, createEntityId } from './events'

describe('createEntityId', () => {
  it('prefixes ids with the entity kind', () => {
    for (const kind of ENTITY_KINDS) {
      expect(createEntityId(kind)).toMatch(new RegExp(`^${kind}_[0-9a-f-]{36}$`))
    }
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createEntityId('session')))

    expect(ids.size).toBe(100)
  })
})
