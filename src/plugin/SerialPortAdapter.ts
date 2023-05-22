import _ from 'lodash'
import { Duplex } from 'stream'
import { SerialPort } from 'serialport'
import { type ChameleonSerialPort, type ChameleonPlugin, type PluginInstallContext } from '../Chameleon'

export default class ChameleonSerialPortAdapter implements ChameleonPlugin {
  name = 'adapter'

  async install (context: AdapterInstallContext, pluginOption: SerialPortOption): Promise<AdapterInstallResp> {
    const { chameleon } = context

    if (!_.isNil(chameleon.$adapter)) {
      await chameleon.disconnect()
    }

    const adapter: any = {}

    adapter.isSupported = (): boolean => !_.isNil(SerialPort)

    if (_.isNil(pluginOption?.baudRate)) pluginOption.baudRate = 115200

    chameleon.addHook('connect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      try {
        if (adapter.isSupported() !== true) throw new Error('SerialPort not supported')

        const port = await new Promise<SerialPort>((resolve, reject) => {
          const port1 = new SerialPort(pluginOption as any, err => { _.isNil(err) ? resolve(port1) : reject(err) })
        })
        port.once('close', () => { void chameleon.disconnect() })
        chameleon.verboseLog(`port connected, path = ${pluginOption.path}, baudRate = ${pluginOption.baudRate as number}`)
        const toWeb = Duplex.toWeb(port) as any
        toWeb.isOpen = () => { return port.isOpen }
        chameleon.port = toWeb satisfies ChameleonSerialPort<Buffer, Buffer>
        return await next()
      } catch (err) {
        chameleon.verboseLog(err)
        throw err
      }
    })

    chameleon.addHook('disconnect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      const port = chameleon.port as unknown as SerialPort
      await next()
      if (_.isNil(port)) return
      await new Promise<void>((resolve, reject) => { port.close?.(err => { _.isNil(err) ? resolve() : reject(err) }) })
    })

    return adapter as AdapterInstallResp
  }
}

type AdapterInstallContext = PluginInstallContext & {
  chameleon: PluginInstallContext['chameleon'] & { $adapter?: any }
}

export interface SerialPortOption {
  path: string
  baudRate?: number
}

interface AdapterInstallResp {
  isSuppored: () => boolean
}
