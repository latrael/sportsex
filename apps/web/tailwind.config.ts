import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:     '#f4f7fe',
        panel:  '#ffffff',
        panel2: '#f0f4fb',
        edge:   '#dde3f0',
        ink:    '#0f172a',
        mute:   '#64748b',
        accent: '#2563eb',
        up:     '#16a34a',
        down:   '#dc2626',
        danger: '#dc2626',
        warn:   '#d97706',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 3px 0 rgba(15,23,42,0.07), 0 0 0 1px rgba(15,23,42,0.04)',
        'card-hover': '0 4px 12px 0 rgba(15,23,42,0.10), 0 0 0 1px rgba(37,99,235,0.15)',
      },
    },
  },
  plugins: [],
};
export default config;
