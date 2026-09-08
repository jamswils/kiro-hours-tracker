import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),

  // Browser-side TypeScript (src/**, vite.config.ts). server/** is excluded so
  // it does not inherit browser globals — flat config MERGES globals from every
  // matching block, so the only way to give the backend node-instead-of-browser
  // is to keep it out of this one.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['server/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Express backend: node globals, no React plugins (react-hooks and
  // react-refresh have nothing to say about a server). Type-aware linting is
  // deliberately not enabled — tsconfig.server.json carries type checking.
  {
    files: ['server/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Plain-JS node tooling: helper scripts and this config file itself, which
  // were previously unlinted because the TS block only matched .ts/.tsx.
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },
])
