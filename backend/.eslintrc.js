module.exports = {
  env: {
    commonjs: true,
    es6: true,
    node: true,
    'jest/globals': true
  },
  extends: [
    'standard'
  ],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly'
  },
  parserOptions: {
    ecmaVersion: 2021
  },
  rules: {
    semi: ['error', 'always'],
    'no-constant-condition': ['off', 'always'],
    'handle-callback-err': ['warn', 'always'],
    'no-trailing-spaces': ['error'],
    'no-prototype-builtins': ['off'],
    'max-len': ['error', { code: 100 }]
  },
  plugins: ['jest']
};
