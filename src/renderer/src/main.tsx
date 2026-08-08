import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './app.css'

export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

const container = document.getElementById('root')
if (container !== null) {
  mount(container)
}
