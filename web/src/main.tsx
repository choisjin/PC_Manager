import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
// 화면 언어 (한국어 ↔ English): 엔진 + English 사전 — App 보다 먼저
import './i18n/engine'
import './i18n/en'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
