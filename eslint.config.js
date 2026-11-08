'use strict';
// `npm run lint` is part of `npm test`. no-undef catches references to removed or
// misspelled names (review #15: an undefined variable made /api/policy/activate always fail).
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'artifacts/**', 'cache/**', 'coverage/**', 'src/web/public/assets/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['error', { checkLoops: false }]
    }
  },
  {
    files: ['src/web/public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } }
  },
  {
    files: ['test/contracts/**/*.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha, ethers: 'readonly', hre: 'readonly' } }
  }
];
