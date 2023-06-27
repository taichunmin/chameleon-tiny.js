import _ from 'lodash'

type BufferEncoder = (...args: any[]) => BufferPolyfill

const BufferEncoders = new Map<string, BufferEncoder>([
  // ['hex', (): string => {}],
  // ['utf8', (): string => {}],
  // ['utf-8', (): string => {}],
  // ['ascii', (): string => {}],
  // ['latin1', (): string => {}],
  // ['binary', (): string => {}],
  // ['base64', (): string => {}],
  // ['ucs2', (): string => {}],
  // ['ucs-2', (): string => {}],
  // ['utf16le', (): string => {}],
  // ['utf-16le', (): string => {}],
])

class BufferPolyfill extends Uint8Array {
  static from (value?: any, encodingOrOffset?: any, length?: any): BufferPolyfill {
    if (_.isNil(value)) throw new TypeError(`The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type ${typeof value}`)
    if (value instanceof ArrayBuffer) return new BufferPolyfill(value)
    if (ArrayBuffer.isView(value)) return new BufferPolyfill(value.buffer, value.byteOffset, value.byteLength)
    if (_.isString(value)) return BufferPolyfill.fromString(value, encodingOrOffset)
  }

  static fromString (value: string, encoding: string = ''): BufferPolyfill {
    if (encoding === '') encoding = 'utf8'
    const encoder = BufferEncoders.get(encoding)
    if (_.isNil(encoder)) throw new TypeError('Unknown encoding: ' + encoding)
    return encoder(value)
  }

  static fromArrayLike (arr: number[]): BufferPolyfill {
    return new BufferPolyfill(new Uint8Array(arr))
  }

  static isEncoding (encoding: string): boolean {
    return BufferEncoders.has(encoding)
  }
}

const BufferExported = typeof Buffer !== 'undefined' ? Buffer : BufferPolyfill
export default BufferExported
