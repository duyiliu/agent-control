import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev backend: the single instance from agent-control.yaml (8788, token-gated).
// First open http://127.0.0.1:8788/?token=<token> once so the ac_ui_token
// cookie lands. The cookie is host-only and ignores ports, so the dev server
// must be opened as 127.0.0.1 too — hence server.host below (vite's default
// binds ::1, which is a different cookie host). Override with AC_API if another
// target is needed.
const apiTarget = process.env.AC_API ?? 'http://127.0.0.1:8788';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': apiTarget },
  },
  build: { outDir: 'dist' },
});
