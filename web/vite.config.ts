import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER = 'http://localhost:5063'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 개발 중에는 API와 SignalR을 ASP.NET Core 서버로 넘긴다
    proxy: {
      '/api': SERVER,
      '/hubs': { target: SERVER, ws: true },
    },
  },
})
