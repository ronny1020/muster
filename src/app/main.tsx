import { createRoot } from 'react-dom/client'

import { App } from './App'
import { SettingsProvider } from '../entities/preferences/model/useSettings'
import './index.css'

// No StrictMode: terminals own PTY processes, and its double-mounted effects
// would spawn each session twice in development.
createRoot(document.querySelector('#root')!).render(
  <SettingsProvider>
    <App />
  </SettingsProvider>,
)
