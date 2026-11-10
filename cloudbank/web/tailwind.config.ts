import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: '#f7f6f2',
          card: '#ffffff',
          divider: '#e5e3dc',
          green: '#0a4d35',
          'green-deep': '#073825',
          gold: '#b8892e',
          text: '#141413',
          muted: '#63615b',
          danger: '#b91c1c',
        },
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: {
        '2xl': '0.75rem',
      },
      boxShadow: {
        card: 'none',
      },
    },
  },
  plugins: [],
} satisfies Config
