import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      '.tsbuild',
      'playwright-report',
      'test-results',
    ],
  },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      jsxA11y.flatConfigs.recommended,
    ],
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
      'react-refresh/only-export-components': 'off',
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/util/{savingsMath,mortgageMath,demoClock}.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='**']",
          message: 'Exponentiation (**) is banned in exact integer math kernels.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
          message: 'Math.round is banned in exact integer math kernels; use halfUp.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='pow']",
          message: 'Math.pow is banned in exact integer math kernels.',
        },
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: 'toFixed is banned in exact integer math kernels; format integer pence.',
        },
        {
          selector: "CallExpression[callee.property.name='toISOString']",
          message: 'toISOString() shifts calendar dates in UTC; format local integer components.',
        },
      ],
    },
  },
  {
    files: ['src/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'react-hooks/globals': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
)
