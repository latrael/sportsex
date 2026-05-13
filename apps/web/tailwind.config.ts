import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0e1a',
        panel: '#121826',
        panel2: '#1a2233',
        edge: '#2a3447',
        ink: '#e6ebf5',
        mute: '#8593ad',
        accent: '#10b981',
        danger: '#ef4444',
        warn: '#f59e0b',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
