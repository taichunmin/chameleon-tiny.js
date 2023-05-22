import _ from 'lodash'
import { type ChameleonPlugin, type PluginInstallContext, type ChameleonSerialPort } from '../Chameleon'
import { serial } from 'web-serial-polyfill'

const WEBSERIAL_FILTERS = [
  { usbVendorId: 0x16d0, usbProductId: 0x04b2 }, // Chameleon Tiny
]

export default class ChameleonWebserialAdapter implements ChameleonPlugin {
  name = 'adapter'

  async install (context: AdapterInstallContext, pluginOption: any): Promise<AdapterInstallResp> {
    const { chameleon } = context

    if (!_.isNil(chameleon.$adapter)) await chameleon.disconnect()
    const adapter: any = {}

    adapter.isSupported = (): boolean => !_.isNil(serial)

    chameleon.addHook('connect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      try {
        if (adapter.isSupported() !== true) throw new Error('WebSerial not supported')
        const port = await serial?.requestPort({ filters: WEBSERIAL_FILTERS }) as any
        if (_.isNil(port)) throw new Error('user canceled')
        const info = await port.getInfo() as { usbVendorId: number, usbProductId: number }
        chameleon.verboseLog(`port selected, usbVendorId = ${info.usbVendorId}, usbProductId = ${info.usbProductId}`)

        await port.open({ baudRate: 115200 })
        port.isOpen = (): boolean => { return port._isOpen ?? false }
        port._isOpen = true
        port.addEventListener?.('disconnect', () => { void chameleon.disconnect() })
        chameleon.port = port satisfies ChameleonSerialPort<Buffer, Buffer>
        return await next()
      } catch (err) {
        chameleon.verboseLog(err)
        throw err
      }
    })

    chameleon.addHook('disconnect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      const port = chameleon.port as any
      port._isOpen = false
      await next()
      if (_.isNil(port)) return
      port.close?.()
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
