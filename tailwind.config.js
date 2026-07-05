/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 简约淡雅,但饱和度与亮度略高于上一版,避免发灰
        bg: {
          app: '#fbfbfd',
          surface: '#ffffff',
          subtle: '#f3f5f9',
          hover: '#eaedf3',
        },
        line: {
          DEFAULT: '#e6e9ef',
          strong: '#d6dae3',
        },
        ink: {
          primary: '#2c3142',
          secondary: '#5a6172',
          tertiary: '#8a91a1',
        },
        accent: {
          DEFAULT: '#3b6fe0',
          bg: '#e8efff',
        },
        danger: '#d65a5a',
        group: {
          1: '#5b8def',
          2: '#3ba776',
          3: '#e0913a',
          4: '#c85a7a',
          5: '#7a6bd0',
          6: '#3bb5b0',
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
        float: '0 8px 24px rgba(0,0,0,.08)',
      },
    },
  },
  plugins: [],
}
