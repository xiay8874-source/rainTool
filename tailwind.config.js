/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 低对比度、简约淡雅配色
        bg: {
          app: '#fafafa',
          surface: '#ffffff',
          subtle: '#f4f5f7',
          hover: '#eef0f3',
        },
        line: {
          DEFAULT: '#ebecef',
          strong: '#e0e2e6',
        },
        ink: {
          primary: '#3a3d42',
          secondary: '#6b7178',
          tertiary: '#9aa0a8',
        },
        accent: {
          DEFAULT: '#6b7c93',
          bg: '#eef1f5',
        },
        danger: '#b08584',
        group: {
          1: '#a8b0bd',
          2: '#a3a89c',
          3: '#9aa6b0',
          4: '#b0a3a1',
          5: '#a5a8b5',
          6: '#9eada6',
        },
      },
      fontSize: {
        // 克制字号,无大字
        page: ['13px', { lineHeight: '1.5', fontWeight: '500' }],
        body: ['12px', { lineHeight: '1.5' }],
        caption: ['11px', { lineHeight: '1.5' }],
        label: ['10px', { lineHeight: '1.4', fontWeight: '500' }],
        code: ['12px', { lineHeight: '1.6' }],
      },
      borderRadius: {
        card: '6px',
        btn: '4px',
      },
      boxShadow: {
        float: '0 8px 24px rgba(0,0,0,.06)',
      },
    },
  },
  plugins: [],
}
