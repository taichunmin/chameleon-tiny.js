import _ from 'lodash'
import { Buffer } from 'buffer'
import { asBuffer, middlewareCompose, sleep, type MiddlewareComposeFn } from './helper'
import { type ReadableStream, type UnderlyingSink, WritableStream } from 'web-streams-polyfill'

const READ_DEFAULT_TIMEOUT = 5e3
const XMODEM_BLOCK_SIZE = 128

export class Chameleon {
  hooks: Record<string, MiddlewareComposeFn[]>
  plugins: Map<string, ChameleonPlugin>
  port?: ChameleonSerialPort<Buffer, Buffer>
  rxSink?: ChameleonRxSink
  supportedConfs?: Set<string>
  verboseFunc?: (text: string) => void
  versionString: string = ''

  constructor (verboseFunc?: (text: string) => void) {
    this.hooks = {}
    this.plugins = new Map()
    this.verboseFunc = verboseFunc
  }

  verboseLog (text: string): void {
    this.verboseFunc?.(text)
  }

  async use (plugin: ChameleonPlugin, option?: any): Promise<this> {
    const pluginId = `$${plugin.name}`
    const installResp = await plugin.install({
      chameleon: this,
    }, option)
    if (!_.isNil(installResp)) (this as Record<string, any>)[pluginId] = installResp
    return this
  }

  addHook (hook: string, fn: MiddlewareComposeFn): this {
    if (!_.isArray(this.hooks[hook])) this.hooks[hook] = []
    this.hooks[hook].push(fn)
    return this
  }

  async invokeHook (hook: string, ctx: any = {}, next: MiddlewareComposeFn): Promise<unknown> {
    ctx.me = this
    return await middlewareCompose(this.hooks[hook] ?? [])(ctx, next)
  }

  async connect (): Promise<void> {
    await this.invokeHook('connect', {}, async (ctx, next) => {
      try {
        if (_.isNil(this.port)) throw new Error('this.port is undefined. Did you remember to use adapter plugin?')

        // serial.readable pipeTo this.rxSink
        this.rxSink = new ChameleonRxSink()
        void this.port.readable.pipeTo(new WritableStream(this.rxSink))
          .catch(err => {
            void this.disconnect()
            throw _.set(new Error('serial.readable.pipeTo error'), 'originalError', err)
          })

        // Send escape key to force clearing the Chameleon's input buffer
        await this.writeBuffer(Buffer.from(CHAR.ESCAPE, 'ascii'))
        this.verboseLog('connected')

        // Try to retrieve chameleons version information and supported confs
        this.versionString = await this.cmdGetVersion()
        this.supportedConfs = new Set(await this.getCmdSuggestions(COMMAND.CONFIG))
      } catch (err) {
        this.verboseLog(`Failed to connect: ${err.message as string}`)
        if (this.isConnected()) await this.disconnect()
        throw _.set(new Error(err.message ?? 'Failed to connect'), 'originalError', err)
      }
    })
  }

  async disconnect (): Promise<void> {
    await this.invokeHook('disconnect', {}, async (ctx, next) => {
      try {
        this.verboseLog('disconnected')
        delete this.port
      } catch (err) {
        throw _.set(new Error('Failed to disconnect'), 'originalError', err)
      }
    })
  }

  isConnected (): boolean {
    return this?.port?.isOpen?.() ?? false
  }

  async writeBuffer (buf: Buffer): Promise<void> {
    await this.invokeHook('writeBuffer', { buf }, async (ctx, next) => {
      try {
        if (!Buffer.isBuffer(ctx.buf)) throw new TypeError('buf should be a Buffer')
        if (!this.isConnected()) await this.connect()
        const writer = this.port?.writable?.getWriter()
        if (_.isNil(writer)) throw new Error('Failed to getWriter(). Did you remember to use adapter plugin?')
        await writer.write(ctx.buf)
        writer.releaseLock()
      } catch (err) {
        throw _.set(new Error(err.message ?? 'Failed to write buffer'), 'originalError', err)
      }
    })
  }

  clearRxBufs (): Buffer[] {
    return this.rxSink?.bufs.splice(0, this.rxSink.bufs.length) ?? []
  }

  async readLineTimeout ({ timeout }: { timeout?: number }): Promise<string> {
    interface Context {
      startedAt?: number
      nowts?: number
      timeout?: number
    }
    return await this.invokeHook('readLineTimeout', { timeout }, async (ctx: Context, next) => {
      try {
        if (!this.isConnected()) await this.connect()
        if (_.isNil(this.rxSink)) throw new Error('rxSink is undefined')
        ctx.timeout = ctx.timeout ?? READ_DEFAULT_TIMEOUT
        ctx.startedAt = Date.now()
        while (true) {
          if (!this.isConnected()) throw new Error('device disconnected')
          ctx.nowts = Date.now()
          if (ctx.nowts > ctx.startedAt + ctx.timeout) throw new Error(`readBytesTimeout ${ctx.timeout}ms`)
          let buf = Buffer.concat(this.clearRxBufs())
          const indexEol = buf.indexOf(ASCII.CR)
          if (indexEol >= 0) {
            const text = buf.subarray(0, indexEol).toString('ascii')
            buf = buf.subarray(indexEol + 1)
            if (buf[0] === ASCII.LF) buf = buf.subarray(1) // trim LF
            if (buf.length > 0) this.rxSink.bufs.unshift(buf)
            return text
          } else if (buf.length > 0) this.rxSink?.bufs.unshift(buf)
          await sleep(10)
        }
      } catch (err) {
        throw _.set(new Error('Failed to read line'), 'originalError', err)
      }
    }) as string
  }

  async readRespTimeout<T> ({ timeout }: { timeout?: number }): Promise<RxReadResp<T>> {
    interface Context {
      startedAt?: number
      nowts?: number
      timeout?: number
    }
    return await this.invokeHook('readRespTimeout', { timeout }, async (ctx: Context, next) => {
      try {
        const status = await this.readLineTimeout({ timeout: ctx.timeout })
        if (status.length < 1) throw new Error('failed to read status')
        const resp: Partial<RxReadResp<string | boolean>> = {}
        const [statusCode, statusText] = _.map(status.split(':', 2), _.trim)
        resp.statusCode = _.parseInt(statusCode)
        resp.statusText = statusText
        if (resp.statusCode !== STATUS_CODE.OK_WITH_TEXT) resp.response = STATUS_CODES_SUCCESS.has(resp.statusCode)
        else resp.response = await this.readLineTimeout({ timeout: ctx.timeout })
        return resp
      } catch (err) {
        throw _.set(new Error('Failed to read response'), 'originalError', err)
      }
    }) as RxReadResp<T>
  }

  async readBytesTimeout ({ len, timeout }: { len: number, timeout?: number }): Promise<Buffer> {
    interface Context {
      startedAt?: number
      nowts?: number
      timeout?: number
    }
    return await this.invokeHook('readBytesTimeout', { timeout }, async (ctx: Context, next) => {
      try {
        if (!this.isConnected()) await this.connect()
        if (_.isNil(this.rxSink)) throw new Error('rxSink is undefined')
        ctx.timeout = ctx.timeout ?? READ_DEFAULT_TIMEOUT
        ctx.startedAt = Date.now()
        while (true) {
          if (!this.isConnected()) throw new Error('device disconnected')
          ctx.nowts = Date.now()
          if (ctx.nowts > ctx.startedAt + ctx.timeout) throw new Error(`readBytesTimeout ${ctx.timeout}ms`)
          const buf = Buffer.concat(this.clearRxBufs())
          if (buf.length >= len) {
            if (buf.length > len) this.rxSink?.bufs.unshift(buf.subarray(len))
            return buf.subarray(0, len)
          } else if (buf.length > 0) this.rxSink?.bufs.unshift(buf)
          await sleep(10)
        }
      } catch (err) {
        throw _.set(new Error('Failed to read bytes'), 'originalError', err)
      }
    }) as Buffer
  }

  async readXmodem (): Promise<Buffer> {
    const rxSink = this.rxSink
    if (_.isNil(rxSink)) throw new Error('rxSink is undefined')

    let bytesReceived: number = 0
    let packetCounter: number = 1
    const bufs = []
    const startedAt = Date.now()
    this.verboseLog('read XMODEM started')

    await this.writeBuffer(Buffer.from([XMODEM_BYTE.NAK]))
    while (true) {
      try {
        const pktType = (await this.readBytesTimeout({ len: 1 }))[0]
        if (_.includes([XMODEM_BYTE.CAN, XMODEM_BYTE.ESC], pktType)) break // cancel
        if (pktType === XMODEM_BYTE.EOT) { // Transmission finished
          await this.writeBuffer(Buffer.from([XMODEM_BYTE.ACK]))
          break
        }
        if (pktType !== XMODEM_BYTE.SOH) continue // Ignore other bytes

        const pktCnt = await this.readBytesTimeout({ len: 2 })
        if (pktCnt[0] + pktCnt[1] !== 0xFF) throw new Error(`invalid pktCnt = 0x${pktCnt.toString('hex')}`)
        const packet = await this.readBytesTimeout({ len: XMODEM_BLOCK_SIZE + 1 })
        if (packet[XMODEM_BLOCK_SIZE] !== _.sum(packet.subarray(0, XMODEM_BLOCK_SIZE)) % 256) throw new Error('checksum mismatch')
        if (pktCnt[0] === packetCounter) bufs.push(packet.subarray(0, XMODEM_BLOCK_SIZE)) // ignore retransmission
        bytesReceived += XMODEM_BLOCK_SIZE
        packetCounter++
        await this.writeBuffer(Buffer.from([XMODEM_BYTE.ACK]))
      } catch (err) {
        this.verboseLog(`readXmodem error: ${err.message as string}`)
        await this.writeBuffer(Buffer.from([XMODEM_BYTE.NAK]))
      }
    }
    const timeDelta = Date.now() - startedAt
    this.verboseLog(`${bytesReceived} bytes recieved in ${timeDelta}ms`)
    return Buffer.concat(bufs)
  }

  async writeLine<T = boolean> ({ line, timeout }: { line: string, timeout?: number }): Promise<RxReadResp<T>> {
    this.clearRxBufs()
    await this.writeBuffer(Buffer.from(`${line}${CHAR.CRLF}`, 'ascii'))
    return await this.readRespTimeout({ timeout })
  }

  async writeXmodem (buf: Buffer): Promise<number> {
    const rxSink = this.rxSink
    if (_.isNil(rxSink)) throw new Error('rxSink is undefined')

    let bytesSent: number = 0
    let packetCounter: number = 1
    this.verboseLog('writeXmodem: Waiting for NAK')

    // Timeout or unexpected char received
    if ((await this.readBytesTimeout({ len: 1 }))[0] !== XMODEM_BYTE.NAK) return 0

    while (bytesSent < buf.length) {
      const packet = Buffer.alloc(XMODEM_BLOCK_SIZE + 4)
      packet[0] = XMODEM_BYTE.SOH
      packet[1] = packetCounter
      packet[2] = 0xFF - packetCounter
      buf.copy(packet, 3, bytesSent, bytesSent + XMODEM_BLOCK_SIZE)
      packet[XMODEM_BLOCK_SIZE + 3] = _.sum(packet.subarray(3, XMODEM_BLOCK_SIZE + 3))
      await this.writeBuffer(packet)
      if ((await this.readBytesTimeout({ len: 1 }))[0] !== XMODEM_BYTE.ACK) continue // resend
      packetCounter++
      bytesSent += XMODEM_BLOCK_SIZE
    }
    await this.writeBuffer(Buffer.from([XMODEM_BYTE.EOT]))
    await this.readBytesTimeout({ len: 1 })
    this.verboseLog(`writeXmodem: ${bytesSent} bytes sent.`)
    return bytesSent
  }

  async cmdExecOrFail<T = boolean> ({ line, timeout }: { line: string, args?: string, timeout?: number }): Promise<T> {
    const resp = await this.writeLine<T>({ line, timeout })
    if (STATUS_CODES_FAILURE.has(resp.statusCode)) throw new Error(`Failed to exec ${JSON.stringify(line)}`)
    return resp.response
  }

  async cmdGetOrFail ({ cmd, timeout }: { cmd: COMMAND, timeout?: number }): Promise<string> {
    const resp = await this.writeLine<string>({ line: `${cmd}${CHAR.GET}`, timeout })
    if (resp.statusCode !== STATUS_CODE.OK_WITH_TEXT) throw new Error(`Failed to get ${cmd}`)
    return resp.response
  }

  async cmdSetOrFail ({ cmd, val, timeout }: { cmd: COMMAND, val: string, timeout?: number }): Promise<void> {
    if (val === CHAR.SUGGEST) throw new Error(`val cannot be ${CHAR.SUGGEST}`)
    const resp = await this.writeLine<string>({ line: `${cmd}${CHAR.SET}${val}`, timeout })
    if (STATUS_CODES_FAILURE.has(resp.statusCode)) throw new Error(`Failed to set ${cmd}`)
  }

  async cmdGetVersion (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.VERSION })
  }

  async cmdSetConfig (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.CONFIG, val })
  }

  async cmdGetConfig (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.CONFIG })
  }

  async cmdSetUid (val: string | Buffer): Promise<void> {
    if (Buffer.isBuffer(val)) val = val.toString('hex')
    await this.cmdSetOrFail({ cmd: COMMAND.UID, val })
  }

  async cmdGetUid (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.UID })
  }

  async cmdSetReadonly (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.READONLY, val })
  }

  async cmdGetReadonly (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.READONLY })
  }

  async cmdExecUpload (buf: Buffer): Promise<number> {
    const resp = await this.writeLine({ line: COMMAND.UPLOAD })
    if (resp.statusCode !== STATUS_CODE.WAITING_FOR_XMODEM) throw new Error('Failed to switch to XModem')
    return await this.writeXmodem(buf)
  }

  async cmdExecDownload (): Promise<Buffer> {
    const resp = await this.writeLine({ line: COMMAND.DOWNLOAD })
    if (resp.statusCode !== STATUS_CODE.WAITING_FOR_XMODEM) throw new Error('Failed to switch to XModem')
    return await this.readXmodem()
  }

  async cmdExecReset (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.RESET })
  }

  async cmdExecUpgrade (): Promise<void> {
    await this.writeBuffer(Buffer.from(`${COMMAND.UPGRADE}${CHAR.CRLF}`, 'ascii'))
  }

  async cmdGetMemSize (): Promise<number> {
    return _.parseInt(await this.cmdGetOrFail({ cmd: COMMAND.MEMSIZE }))
  }

  async cmdGetUidSize (): Promise<number> {
    return _.parseInt(await this.cmdGetOrFail({ cmd: COMMAND.UIDSIZE }))
  }

  async cmdSetRbutton (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.RBUTTON, val })
  }

  async cmdGetRbutton (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.RBUTTON })
  }

  async cmdSetRbuttonLong (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.RBUTTON_LONG, val })
  }

  async cmdGetRbuttonLong (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.RBUTTON_LONG })
  }

  async cmdSetLbutton (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.LBUTTON, val })
  }

  async cmdGetLbutton (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.LBUTTON })
  }

  async cmdSetLbuttonLong (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.LBUTTON_LONG, val })
  }

  async cmdGetLbuttonLong (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.LBUTTON_LONG })
  }

  async cmdSetLedGreen (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.LEDGREEN, val })
  }

  async cmdGetLedGreen (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.LEDGREEN })
  }

  async cmdSetLedRed (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.LEDRED, val })
  }

  async cmdGetLedRed (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.LEDRED })
  }

  async cmdSetLogMode (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.LOGMODE, val })
  }

  async cmdGetLogMode (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.LOGMODE })
  }

  async cmdGetLogMem (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.LOGMEM })
  }

  async cmdExecLogDownload (): Promise<Buffer> {
    const resp = await this.writeLine({ line: COMMAND.LOGDOWNLOAD })
    if (resp.statusCode !== STATUS_CODE.WAITING_FOR_XMODEM) throw new Error('Failed to switch to XModem')
    return await this.readXmodem()
  }

  async cmdExecLogStore (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.LOGSTORE })
  }

  async cmdExecLogClear (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.LOGCLEAR })
  }

  async cmdSetSetting (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.SETTING, val })
  }

  async cmdGetSetting (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.SETTING })
  }

  async cmdExecClear (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.CLEAR })
  }

  async cmdExecStore (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.STORE })
  }

  async cmdExecRecall (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.RECALL })
  }

  async cmdGetCharging (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.CHARGING })
  }

  async cmdExecHelp (): Promise<string[]> {
    return (await this.cmdExecOrFail<string>({ line: COMMAND.HELP })).split(',')
  }

  async cmdGetRssi (): Promise<number> {
    return _.parseInt(await this.cmdGetOrFail({ cmd: COMMAND.RSSI }))
  }

  async cmdGetSysTick (): Promise<number> {
    return _.parseInt(await this.cmdGetOrFail({ cmd: COMMAND.SYSTICK }))
  }

  // async cmdExecParamSendRaw (): Promise<void> {
  //   await this.cmdExecOrFail({ line: COMMAND.SEND_RAW })
  //   // TODO: implemet
  // }

  // async cmdExecParamSend (): Promise<void> {
  //   await this.cmdExecOrFail({ line: COMMAND.SEND })
  //   // TODO: implemet
  // }

  async cmdExecGetUid (): Promise<string> {
    return await this.cmdExecOrFail<string>({ line: COMMAND.GETUID })
  }

  async cmdExecDumpMFU (): Promise<string> {
    return await this.cmdExecOrFail<string>({ line: COMMAND.DUMP_MFU })
    // TODO: implemet
  }

  async cmdExecCloneMFU (): Promise<string> {
    return await this.cmdExecOrFail<string>({ line: COMMAND.CLONE_MFU })
    // TODO: implemet
  }

  async cmdExecIdentifyCard (): Promise<string> {
    return await this.cmdExecOrFail<string>({ line: COMMAND.IDENTIFY })
  }

  async cmdSetTimeout (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.TIMEOUT, val })
  }

  async cmdGetTimeout (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.TIMEOUT })
  }

  async cmdSetThreshold (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.THRESHOLD, val })
  }

  async cmdGetThreshold (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.THRESHOLD })
  }

  async cmdExecAutocalibrate (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.AUTOCALIBRATE })
  }

  async cmdSetField (val: string): Promise<void> {
    await this.cmdSetOrFail({ cmd: COMMAND.FIELD, val })
  }

  async cmdGetField (): Promise<string> {
    return await this.cmdGetOrFail({ cmd: COMMAND.FIELD })
  }

  async cmdExecClone (): Promise<void> {
    await this.cmdExecOrFail({ line: COMMAND.CLONE })
  }

  async getCmdSuggestions (cmd: COMMAND): Promise<string[]> {
    const resp = await this.writeLine<string>({ line: `${cmd}${CHAR.SET}${CHAR.SUGGEST}` })
    if (resp.statusCode !== STATUS_CODE.OK_WITH_TEXT) throw new Error(`Failed to getCmdSuggestions ${cmd}`)
    return resp.response.split(',')
  }
}

export interface ChameleonSerialPort<I, O> {
  isOpen?: () => boolean
  readable: ReadableStream<I>
  writable: WritableStream<O>
}

export class ChameleonRxSink implements UnderlyingSink<Buffer> {
  bufs: Buffer[] = []

  write (chunk: Buffer): void {
    this.bufs.push(asBuffer(chunk))
  }
}

export enum COMMAND {
  ATQA = 'ATQA',
  AUTOCALIBRATE = 'AUTOCALIBRATE',
  BAUDRATE = 'BAUDRATE',
  CHARGING = 'CHARGING',
  CLEAR = 'CLEAR',
  CLONE = 'CLONE',
  CLONE_MFU = 'CLONE_MFU',
  CONFIG = 'CONFIG',
  DETECTION = 'DETECTION',
  DOWNLOAD = 'DOWNLOAD',
  DUMP_MFU = 'DUMP_MFU',
  FIELD = 'FIELD',
  GETUID = 'GETUID',
  HELP = 'HELP',
  IDENTIFY = 'IDENTIFY',
  LBUTTON = 'LBUTTON',
  LBUTTON_LONG = 'LBUTTON_LONG',
  LEDGREEN = 'LEDGREEN',
  LEDMODE = 'LEDMODE',
  LEDRED = 'LEDRED',
  LOGCLEAR = 'LOGCLEAR',
  LOGDOWNLOAD = 'LOGDOWNLOAD',
  LOGMEM = 'LOGMEM',
  LOGMODE = 'LOGMODE',
  LOGSTORE = 'LOGSTORE',
  MEMSIZE = 'MEMSIZE',
  RBUTTON = 'RBUTTON',
  RBUTTON_LONG = 'RBUTTON_LONG',
  READONLY = 'READONLY',
  RECALL = 'RECALL',
  RESET = 'RESET',
  RSSI = 'RSSI',
  SAK = 'SAK',
  SAKMODE = 'SAKMODE',
  SEND = 'SEND',
  SEND_RAW = 'SEND_RAW',
  SETTING = 'SETTING',
  STORE = 'STORE',
  SYSTICK = 'SYSTICK',
  THRESHOLD = 'THRESHOLD',
  TIMEOUT = 'TIMEOUT',
  UID = 'UID',
  UIDMODE = 'UIDMODE',
  UIDSIZE = 'UIDSIZE',
  UPGRADE = 'UPGRADE',
  UPLOAD = 'UPLOAD',
  VERSION = 'VERSION',
}

export enum STATUS_CODE {
  OK = 100,
  OK_WITH_TEXT = 101,
  WAITING_FOR_XMODEM = 110,
  FALSE = 120,
  TRUE = 121,
  UNKNOWN_COMMAND = 200,
  UNKNOWN_COMMAND_USAGE = 201,
  INVALID_PARAMETER = 202,
}

export const STATUS_CODES_SUCCESS = new Set([
  STATUS_CODE.FALSE,
  STATUS_CODE.OK_WITH_TEXT,
  STATUS_CODE.OK,
  STATUS_CODE.TRUE,
  STATUS_CODE.WAITING_FOR_XMODEM,
])

export const STATUS_CODES_FAILURE = new Set([
  STATUS_CODE.INVALID_PARAMETER,
  STATUS_CODE.UNKNOWN_COMMAND_USAGE,
  STATUS_CODE.UNKNOWN_COMMAND,
])

export enum CHAR {
  CRLF = '\r\n',
  SUGGEST = '?',
  SET = '=',
  GET = '?',
  ESCAPE = '\x1B', // ASCII 27
}

export enum ASCII {
  CR = 0x0D,
  LF = 0x0A,
}

interface RxReadResp<T> {
  statusCode: STATUS_CODE
  statusText: string
  response: T
}

export enum XMODEM_BYTE {
  ACK = 0x06,
  CAN = 0x18,
  EOF = 0x1A,
  EOT = 0x04,
  ESC = 0x1B,
  NAK = 0x15,
  SOH = 0x01,
}

export interface PluginInstallContext {
  chameleon: Chameleon
}

export interface ChameleonPlugin {
  name: string
  install: <T extends PluginInstallContext>(context: T, pluginOption: any) => Promise<unknown>
}
