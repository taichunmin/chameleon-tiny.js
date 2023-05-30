import _ from 'lodash'
import { bluetooth } from 'webbluetooth'
import { Buffer } from 'buffer'
import { sleep, asBuffer } from '../helper'
import { type Chameleon, type ChameleonPlugin, type ChameleonSerialPort, type PluginInstallContext } from '../Chameleon'
import {
  ReadableStream,
  type ReadableStreamDefaultController,
  type UnderlyingSink,
  type UnderlyingSource,
  WritableStream,
} from 'web-streams-polyfill'

const BLESERIAL_FILTERS = [
  { name: 'ChameleonTiny' },
]

const BLESERIAL_UUID = [
  { // ChameleonTiny
    serv: '51510001-7969-6473-6f40-6b6f6c6c6957',
    send: '51510002-7969-6473-6f40-6b6f6c6c6957',
    recv: '51510003-7969-6473-6f40-6b6f6c6c6957',
    ctrl: '51510004-7969-6473-6f40-6b6f6c6c6957',
  },
]

export default class ChameleonWebbleAdapter implements ChameleonPlugin {
  chameleon?: Chameleon
  ctrl?: BluetoothRemoteGATTCharacteristic
  device?: BluetoothDevice
  isOpen: boolean = false
  name = 'adapter'
  recv?: BluetoothRemoteGATTCharacteristic
  rxSource?: ChameleonWebbleAdapterRxSource
  send?: BluetoothRemoteGATTCharacteristic
  serv?: BluetoothRemoteGATTService
  txSink?: ChameleonWebbleAdapterTxSink

  async install (context: AdapterInstallContext, pluginOption: any): Promise<AdapterInstallResp> {
    const { chameleon } = context
    this.chameleon = chameleon

    if (!_.isNil(chameleon.$adapter)) await chameleon.disconnect()
    const adapter: any = {}

    const _isSupported = await bluetooth?.getAvailability() ?? false
    adapter.isSupported = (): boolean => _isSupported

    // connect gatt
    const gattIsConnected = (): boolean => { return this.device?.gatt?.connected ?? false }

    chameleon.addHook('connect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      try {
        if (adapter.isSupported() !== true) throw new Error('WebSerial not supported')
        this.device = await bluetooth?.requestDevice({
          filters: BLESERIAL_FILTERS,
          optionalServices: _.uniq(_.map(BLESERIAL_UUID, 'serv')),
        })
        if (_.isNil(this.device)) throw new Error('no device')
        chameleon.verboseLog(`device selected, name = ${this.device.name ?? 'null'}, id = ${this.device.id}`)

        for (let i = 0; i < 50; i++) {
          await this.device.gatt?.connect().catch(() => {})
          if (gattIsConnected()) break
          await sleep(50)
        }
        if (!gattIsConnected()) throw new Error('Failed to connect gatt')
        this.device.addEventListener('gattserverdisconnected', () => { void chameleon.disconnect() })

        this.rxSource = new ChameleonWebbleAdapterRxSource(this)
        this.txSink = new ChameleonWebbleAdapterTxSink(this)

        // find serv, send, recv, ctrl
        const primaryServices = _.map(await this.device.gatt?.getPrimaryServices(), 'uuid')
        for (const uuids of BLESERIAL_UUID) {
          try {
            if (!_.includes(primaryServices, uuids.serv)) continue
            this.serv = await this.device.gatt?.getPrimaryService(uuids.serv)
            this.send = await this.serv?.getCharacteristic(uuids.send)
            this.recv = await this.serv?.getCharacteristic(uuids.recv)
            this.recv?.addEventListener('characteristicvaluechanged', (event: any): void => this.rxSource?.onNotify(event))
            await this.recv?.startNotifications()

            try {
              this.ctrl = await this.serv?.getCharacteristic(uuids.ctrl)
              this.ctrl?.addEventListener('characteristicvaluechanged', (event: any): void => this.rxSource?.onNotify(event))
              await this.ctrl?.startNotifications()
            } catch (err) {
              delete this.ctrl
            }

            chameleon.verboseLog(`gatt connected, serv = '${uuids.serv}', recv = '${uuids.recv}', send = '${uuids.send}', ctrl = '${_.isNil(this.ctrl) ? 'null' : uuids.send}'`)
            this.isOpen = true
            break
          } catch (err) {
            chameleon.verboseLog(`${err.message as string}, uuids = ${JSON.stringify(uuids)}`)
          }
        }
        if (!this.isOpen) throw new Error('supported gatt service not found')

        // TODO: getInfoFromMini and getInfoFromTiny in BleCMDControl.java

        chameleon.port = {
          isOpen: () => { return this.isOpen },
          readable: new ReadableStream(this.rxSource),
          writable: new WritableStream(this.txSink),
        } satisfies ChameleonSerialPort<Buffer, Buffer>
        return await next()
      } catch (err) {
        chameleon.verboseLog(`Failed to connect: ${err.message as string}`)
        throw err
      }
    })

    chameleon.addHook('disconnect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      this.isOpen = false
      await next()
      if (_.isNil(this.device)) return
      if (!_.isNil(this.ctrl)) {
        if (gattIsConnected()) await this.ctrl.stopNotifications()
        delete this.ctrl
      }
      if (!_.isNil(this.recv)) {
        if (gattIsConnected()) await this.recv.stopNotifications()
        delete this.recv
        delete this.rxSource
      }
      if (!_.isNil(this.send)) {
        delete this.send
        delete this.txSink
      }
      if (!_.isNil(this.serv)) delete this.serv
      if (gattIsConnected()) this.device.gatt?.disconnect()
      delete this.device
    })

    return adapter as AdapterInstallResp
  }
}

type AdapterInstallContext = PluginInstallContext & {
  chameleon: PluginInstallContext['chameleon'] & { $adapter?: any }
}

interface AdapterInstallResp {
  isSuppored: () => boolean
}

/**
 * The data package of Chameleon Mini and Chameleon Tiny Pro
 * Protocol layout
 * ---------------------------------------------------------------------------------------------
 * START HEAD - CMD - DATA LENGTH - STATUS - DATA
 * e.g(en):
 * 1、START HEAD is final, 1byte and value is 0xA5 {@link #SIGN_HEX}
 * 2、CMD is identifies the type of command currently to be executed,
 * The main function of Bluetooth is to forward serial data，
 * for scalability, we define the forwarding of serial data as a command type {@link #TEXT_HEX}
 * 3、DATA LENGTH is your data length, if no data, length final to 0x00
 * 4、STATUS is all data + head checksum
 * 5、DATA is your data
 * *********************************************************************************************
 * e.g(zh)
 * 第一个字节固定0xA5，非此开头的数据将被忽略，
 * 第二个字节为命令，字符串发送固定为0x75，
 * 第三个字节命令长度是数据的，没数据则填00，
 * 校验和，整个结构包头加数据按字节累加为00。
 */

class ChameleonWebbleAdapterRxSource implements UnderlyingSource<Buffer> {
  adapter: ChameleonWebbleAdapter
  bufs: Buffer[] = []
  controller?: ReadableStreamDefaultController<Buffer>

  constructor (adapter: ChameleonWebbleAdapter) { this.adapter = adapter }

  start (controller: ReadableStreamDefaultController<Buffer>): void { this.controller = controller }

  onNotify (event: any): void {
    const buf = asBuffer(event?.target?.value?.buffer as ArrayBuffer)
    this.adapter.chameleon?.verboseLog(`onNotify = ${buf.subarray(0, 4).toString('hex')} ${buf.subarray(4).toString('hex')}`)
    if (buf[0] !== BLE_BYTES.SOH || buf[1] !== BLE_BYTES.CMD_TEXT || buf[2] + 4 !== buf.length) return
    if ((_.sum(buf) & 0xFF) !== 0) return // checksum mismatch
    this.controller?.enqueue(buf.subarray(4))
  }
}

class ChameleonWebbleAdapterTxSink implements UnderlyingSink<Buffer> {
  adapter: ChameleonWebbleAdapter
  isFirstEsc = true

  constructor (adapter: ChameleonWebbleAdapter) { this.adapter = adapter }

  async write (chunk: Buffer): Promise<void> {
    if (_.isNil(this.adapter.send)) throw new Error('this.adapter.send can not be null')

    // 20 bytes are left for the attribute data
    // https://stackoverflow.com/questions/38913743/maximum-packet-length-for-bluetooth-le
    for (let i = 0; i < chunk.length; i += 20) {
      const buf1 = chunk.subarray(i, i + 20)
      const buf2 = Buffer.alloc(buf1.length + 4)
      buf2.writeUInt16BE(0xA575, 0)
      buf2[2] = buf1.length
      buf1.copy(buf2, 4)
      buf2[3] = 256 - (_.sum(buf2) & 0xFF)
      this.adapter.chameleon?.verboseLog(`bleWrite = ${buf2.subarray(0, 4).toString('hex')} ${buf2.subarray(4).toString('hex')}`)
      await this.adapter.send?.writeValueWithoutResponse(buf2.buffer)
    }
  }
}

enum BLE_BYTES {
  SOH = 0xA5,
  CMD_TEXT = 0x75,
}
