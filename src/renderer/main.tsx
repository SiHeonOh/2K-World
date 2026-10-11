import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { z } from 'zod'
import { ko } from 'zod/locales'
import { App } from './App'
import { AppErrorBoundary } from './components/ErrorBoundary'
import './styles/app.css'
import './styles/wiki.css'
import './styles/mood.css'
import './styles/lore.css'
import './styles/suggest.css'
import './styles/gm.css'

// Zod's own validation messages, in Korean.
z.config(ko())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Screens have their own boundary; this one keeps even a broken frame from leaving the window blank. */}
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
