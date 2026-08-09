import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Fires on destructured React context callbacks (select/clear) and vi.fn
      // mocks that don't use `this` — noise, not real unbound-method bugs.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Config + scripts are plain JS with no project types — turn off the
    // type-aware rules for them and give them Node globals.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
)
