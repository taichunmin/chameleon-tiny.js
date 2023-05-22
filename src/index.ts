import * as Chameleon from './Chameleon'
import pkg from '../package.json' assert { type: 'json' }

const version = pkg.version

export { Chameleon, version }
