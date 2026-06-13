import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont',
          '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      colors: {
        ink: {
          950: '#05070f',
          900: '#070a14',
          850: '#0a0e1c',
          800: '#0e1426'
        }
      },
      boxShadow: {
        glass: '0 24px 70px -28px rgba(2, 6, 23, 0.85)',
        glow: '0 14px 44px -14px rgba(56, 130, 248, 0.5)',
        'glow-emerald': '0 14px 44px -14px rgba(16, 185, 129, 0.45)'
      },
      animation: {
        'fade-in': 'fade-in .2s ease-out both',
        'slide-up': 'slide-up .24s cubic-bezier(.16,1,.3,1) both',
        'drawer-in': 'drawer-in .26s cubic-bezier(.16,1,.3,1) both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        aurora: 'aurora 18s ease-in-out infinite alternate'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(12px) scale(.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' }
        },
        'drawer-in': {
          from: { opacity: '0', transform: 'translateX(28px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        },
        'pulse-soft': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '.5' }
        },
        aurora: {
          '0%': { transform: 'translate3d(0,0,0) scale(1)' },
          '100%': { transform: 'translate3d(4%,-3%,0) scale(1.12)' }
        }
      }
    }
  },
  plugins: []
} satisfies Config;
