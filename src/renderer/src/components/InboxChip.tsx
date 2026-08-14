import { useState } from 'react'

import { useInbox } from '../state/inbox'
import { InboxPanel } from './InboxPanel'

/**
 * The status-bar attention indicator: a count of everything blocked on you
 * (approvals, questions). Highlighted when non-zero; opens the triage panel.
 */
export function InboxChip(): React.JSX.Element {
  const { items } = useInbox()
  const [open, setOpen] = useState(false)
  const count = items.length

  return (
    <>
      <button
        type="button"
        className={`budget budget-button inbox-chip${count > 0 ? ' has-items' : ''}`}
        title="Approvals and questions waiting on you"
        onClick={() => setOpen(true)}
      >
        {count > 0 ? `inbox ${count}` : 'inbox'}
      </button>
      {open && <InboxPanel onClose={() => setOpen(false)} />}
    </>
  )
}
