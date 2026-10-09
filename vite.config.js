import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * Content-Security-Policy for the packaged renderer, as a <meta> injected into dist/index.html.
 *
 * BUILDS ONLY: the dev server needs inline scripts (React Refresh's preamble) and a websocket for
 * HMR, so `npm run dev` runs without it. Everything a document can bring in is limited here as
 * a second line behind the sanitiser in src/markdown.js:
 *   - scripts only from the app itself, never inline, never eval (Mermaid, KaTeX and CodeMirror
 *     need none of it);
 *   - styles from the app, plus inline ones (React style props, KaTeX's glyph positioning,
 *     CodeMirror's injected theme, Mermaid's per-diagram <style>);
 *   - images from the app, data:/blob:, local files over fate-local:, and https: for the
 *     remote images a user chooses to load (src/markdown.js keeps them out until then);
 *   - fonts bundled with the app, nothing fetched or connected to anywhere else, no plugins,
 *     frames, <base> or form submissions.
 * With a policy in place Electron also stops printing its "Insecure Content-Security-Policy"
 * warning in the console.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: fate-local: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function contentSecurityPolicy() {
  return {
    name: 'fate-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend'
      }
    ]
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: './',
  build: {
    target: 'chrome105',
    cssTarget: 'chrome105'
  }
})
