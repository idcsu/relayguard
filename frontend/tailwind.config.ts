import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        soft: '0 24px 80px rgba(15, 23, 42, 0.10)',
        card: '0 18px 60px rgba(15, 23, 42, 0.08)'
      },
      animation: {
        'fade-in': 'fade-in .18s ease-out both',
        'slide-up': 'slide-up .22s ease-out both',
        'drawer-in': 'drawer-in .22s ease-out both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'drawer-in': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        },
        'pulse-soft': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '.55' }
        }
      }
    }
  },
  plugins: []
} satisfies Config;
