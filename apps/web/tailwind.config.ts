import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        office: {
          bg: '#0f172a',
          panel: '#1e293b',
          border: '#334155',
          accent: '#f59e0b',
          emerald: '#10b981',
        },
      },
    },
  },
  plugins: [],
};

export default config;
