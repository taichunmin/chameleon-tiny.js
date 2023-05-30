import _ from 'lodash'
import { serial, type SerialPort } from 'web-serial-polyfill'
import { sleep } from '../helper'
import { type Buffer } from 'buffer'
import { type ChameleonPlugin, type PluginInstallContext, type ChameleonSerialPort } from '../Chameleon'

const WEBSERIAL_FILTERS = [
  { usbVendorId: 0x16d0, usbProductId: 0x04b2 }, // Chameleon Tiny
]

export default class ChameleonWebserialAdapter implements ChameleonPlugin {
  isOpen: boolean = false
  name = 'adapter'
  port?: SerialPort & Partial<ChameleonSerialPort<Buffer, Buffer>> & { addEventListener?: CallableFunction }

  async install (context: AdapterInstallContext, pluginOption: any): Promise<AdapterInstallResp> {
    const { chameleon } = context

    if (!_.isNil(chameleon.$adapter)) await chameleon.disconnect()
    const adapter: any = {}

    adapter.isSupported = (): boolean => !_.isNil(serial)

    chameleon.addHook('connect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      try {
        if (adapter.isSupported() !== true) throw new Error('WebSerial not supported')
        this.port = await serial.requestPort({ filters: WEBSERIAL_FILTERS }) as any
        if (_.isNil(this.port)) throw new Error('user canceled')

        // port.open
        this.port.isOpen = (): boolean => { return this.isOpen }
        await this.port.open({ baudRate: 115200 })
        while (_.isNil(this.port.readable) || _.isNil(this.port.writable)) await sleep(10) // wait for port.readable
        this.isOpen = true

        const info = await this.port.getInfo() as { usbVendorId: number, usbProductId: number }
        chameleon.verboseLog(`port selected, usbVendorId = ${info.usbVendorId}, usbProductId = ${info.usbProductId}`)
        this.port.addEventListener?.('disconnect', () => { void chameleon.disconnect() })
        chameleon.port = this.port satisfies ChameleonSerialPort<Buffer, Buffer>
        return await next()
      } catch (err) {
        chameleon.verboseLog(err)
        throw err
      }
    })

    chameleon.addHook('disconnect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      this.isOpen = false
      await next()
      if (_.isNil(this.port)) return
      await this.port.close()
      delete this.port
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
