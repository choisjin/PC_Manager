import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
// 화면 언어 (한국어 ↔ English): 엔진 + English 사전 — App 보다 먼저
import './i18n/engine'
import './i18n/en'
import App from './App.tsx'
import { importMigrated, upgradeToHttps } from './https'

// HTTP로 열렸으면 되는 대로 HTTPS로 옮긴다 (옮기는 중이면 그리지 않는다)
importMigrated()
void upgradeToHttps().then((moving) => {
  if (moving) return
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
