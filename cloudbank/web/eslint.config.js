// Flat ESLint config. There was no linter here at all before — `tsc -b` was
// the only static gate, which is part of why several agent/UI divergences went
// unnoticed. Deliberately a pragmatic set that passes clean today so it can
// gate CI, rather than a maximal one that gets disabled on first contact.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // eslint-plugin-react-hooks v7 ships the React Compiler ruleset. These
      // three fire on longstanding, deliberate patterns in AgentProvider —
      // the lazy `useRef(null)` registry init, passing that registry into a
      // context value, and setConnState('connecting') at the top of the
      // connection effect. Reworking the provider around them is a real
      // refactor with live-session risk, so they are warnings (visible, not
      // enforced) rather than off.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      // Unused vars are a real signal in this codebase; allow the conventional
      // _-prefix escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests reach into fixture JSON and fake globals; `any` there is noise.
    files: ['src/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      // Test harnesses legitimately capture provider state into module-level
      // variables so assertions can read it after render.
      'react-hooks/globals': 'off',
    },
  },
)
