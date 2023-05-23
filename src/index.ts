import pkg from '../package.json' assert { type: 'json' }

export { Buffer } from 'buffer'
export * from './Chameleon'
export const version = pkg.version
