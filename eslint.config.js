// Correctness only: catches names that aren't defined or imported (the build doesn't — they fail at
// runtime) and a few real mistakes. Style is left alone.
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'server/data/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['client/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      'no-undef': 'error', 'react/jsx-no-undef': 'error', 'react/jsx-uses-vars': 'error', 'react/jsx-uses-react': 'off', 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'off',
      'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-self-assign': 'error', 'no-dupe-else-if': 'error', 'use-isnan': 'error', 'valid-typeof': 'error',
    },
  },
  {
    files: ['server/**/*.js', 'bridge/**/*.mjs', 'e2e/**/*.mjs', 'client/public/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-self-assign': 'error', 'no-dupe-else-if': 'error', 'use-isnan': 'error', 'valid-typeof': 'error' },
  },
];
