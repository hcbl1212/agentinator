// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormattedText } from './FormattedText'

describe('FormattedText', () => {
  it('passes plain prose through untouched', () => {
    render(<FormattedText text={'line one\nline two'} />)
    expect(screen.getByText(/line one/)).toBeInTheDocument()
    expect(document.querySelector('.code-block')).toBeNull()
  })

  it('renders code fences as blocks, stripping the language tag', () => {
    const { container } = render(
      <FormattedText text={'The DDL:\n```sql\nCREATE TABLE x;\n```\nDone.'} />,
    )

    const block = container.querySelector('.code-block')
    expect(block).toHaveTextContent('CREATE TABLE x;')
    expect(block).not.toHaveTextContent('sql')
    expect(screen.getByText(/The DDL:/)).toBeInTheDocument()
    expect(screen.getByText(/Done\./)).toBeInTheDocument()
  })

  it('keeps a bare fence (no language, or no newline) intact', () => {
    const { container } = render(<FormattedText text={'A ```\nplain\n``` and ```inline``` too'} />)

    const blocks = container.querySelectorAll('.code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toHaveTextContent('plain')
    // No language line to strip — the content survives verbatim.
    expect(blocks[1]).toHaveTextContent('inline')
  })
})
