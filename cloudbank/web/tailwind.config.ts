import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: '#f4f4f6',
          card: '#ffffff',
          divider: '#e7e7ea',
          green: '#0a4d35',
          'green-deep': '#073825',
          gold: '#c89b3c',
          text: '#111418',
          muted: '#6b7280',
          danger: '#dc2626',
        },
      },
      fontFamily: {
        sans: ['Inter Variable', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: {
        '2xl': '1.125rem',
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgba(15, 23, 42, 0.06), 0 1px 2px -1px rgba(15, 23, 42, 0.04)',
      },
    },
  },
  plugins: [],
} satisfies Config
