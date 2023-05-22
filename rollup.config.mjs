import _ from 'lodash'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodePolyfills from 'rollup-plugin-polyfill-node'
import pkg from './package.json' assert { type: 'json' }
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'

const external = [
  ..._.keys(pkg.dependencies),
  'stream',
]
const globals = {
  'web-serial-polyfill': 'window.navigator',
  'web-streams-polyfill': 'window',
  lodash: '_',
}

export default [
  // src/index.ts
  {
    external,
    input: 'src/index.ts',
    plugins: [typescript(), nodeResolve({ browser: true }), commonjs(), nodePolyfills(), json()],
    output: [
      { file: 'dist/es/index.mjs', format: 'es' },
      { file: 'dist/cjs/index.cjs', format: 'cjs' },
      { file: 'dist/iife/index.js', format: 'iife', globals, name: 'ChameleonJS' },
      { file: 'dist/iife/index.min.js', format: 'iife', globals, name: 'ChameleonJS', plugins: [terser()] },
    ],
  },

  // src/plugin/SerialPortAdapter.ts (cjs, es)
  {
    external,
    input: `src/plugin/SerialPortAdapter.ts`,
    plugins: [typescript()],
    output: [
      { file: `dist/cjs/plugin/SerialPortAdapter.cjs`, format: 'cjs' },
      { file: `dist/es/plugin/SerialPortAdapter.mjs`, format: 'es' },
    ]
  },

  // src/plugin/WebserialAdapter.ts (esm, iife)
  {
    external,
    input: `src/plugin/WebserialAdapter.ts`,
    plugins: [typescript(), nodeResolve({ browser: true }), commonjs(), nodePolyfills()],
    output: [
      { file: `dist/es/plugin/WebserialAdapter.mjs`, format: 'es' },
      { file: 'dist/iife/plugin/WebserialAdapter.js', format: 'iife', globals, name: 'ChameleonWebserialAdapter' },
      { file: 'dist/iife/plugin/WebserialAdapter.min.js', format: 'iife', globals, name: 'ChameleonWebserialAdapter', plugins: [terser()] },
    ]
  },
]
