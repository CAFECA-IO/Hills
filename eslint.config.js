import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'target/**', 'apps/desktop/src-tauri/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  // 設計系統（D45，docs/design-system.md「規則與檢查」）：畫面只能組合 src/ui/ 元件與 token
  {
    files: ['apps/desktop/src/**/*.tsx'],
    ignores: [
      'apps/desktop/src/ui/**',
      'apps/desktop/src/figures.tsx',
      'apps/desktop/src/dev/**',
      'apps/desktop/src/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea)$/]',
          message:
            '原生互動元素只能在 src/ui/ 內使用：改用 Button / IconButton / LinkButton / Pressable / TextInput / TextArea / Select / Checkbox（docs/components.md）。',
        },
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/]',
          message: '禁止寫死色碼：使用 tokens.css 的設計 token（docs/design-system.md「色彩」）。',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/]',
          message: '禁止寫死色碼：使用 tokens.css 的設計 token（docs/design-system.md「色彩」）。',
        },
        {
          selector:
            'Literal[value=/\\b(text|bg|border|rounded|shadow|fill|stroke|ring|outline|from|via|to|font|leading|tracking|decoration|accent)-\\[/]',
          message:
            '禁止任意的字級、顏色、圓角、陰影值：使用 token（text-2xs…text-3xl、rounded-card / rounded-control，docs/design-system.md）。',
        },
        {
          selector:
            'TemplateElement[value.raw=/\\b(text|bg|border|rounded|shadow|fill|stroke|ring|outline|from|via|to|font|leading|tracking|decoration|accent)-\\[/]',
          message:
            '禁止任意的字級、顏色、圓角、陰影值：使用 token（text-2xs…text-3xl、rounded-card / rounded-control，docs/design-system.md）。',
        },
        {
          selector:
            'Literal[value=/\\b(text|bg|border|fill|stroke|ring|outline|from|via|to|decoration|accent)-(white|black|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]+)\\b/]',
          message: '禁止使用 Tailwind 預設色盤：使用設計 token（bg-surface、text-muted…）。',
        },
        {
          selector:
            'TemplateElement[value.raw=/\\b(text|bg|border|fill|stroke|ring|outline|from|via|to|decoration|accent)-(white|black|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]+)\\b/]',
          message: '禁止使用 Tailwind 預設色盤：使用設計 token（bg-surface、text-muted…）。',
        },
      ],
    },
  },
);
