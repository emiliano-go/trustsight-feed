import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// The feed is dynamic (D1 at runtime), so the frontend is a plain client-side
// Preact app: no SSR, no prerender. The Worker bundles separately via wrangler.
export default defineConfig({
  plugins: [preact()],
  css: {
    transformer: 'lightningcss',
  },
  build: {
    cssMinify: 'lightningcss',
    minify: 'terser',
    terserOptions: {
      compress: {
        defaults: true,
        drop_debugger: true,
        passes: 3,
        pure_getters: 'strict',
      },
      mangle: {
        toplevel: true,
      },
      module: true,
      format: {
        comments: false,
      },
    },
    assetsInlineLimit: 0,
  },
  server: {
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
})
