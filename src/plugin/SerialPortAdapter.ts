import _ from 'lodash'
import { Duplex } from 'stream'
import { SerialPort } from 'serialport'
import { type Buffer } from 'buffer'
import { type ChameleonSerialPort, type ChameleonPlugin, type PluginInstallContext } from '../Chameleon'

export default class ChameleonSerialPortAdapter implements ChameleonPlugin {
  name = 'adapter'
  port?: SerialPort

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

        this.port = await new Promise<SerialPort>((resolve, reject) => {
          const port1 = new SerialPort(pluginOption as any, err => { _.isNil(err) ? resolve(port1) : reject(err) })
        })
        this.port?.once('close', () => { void chameleon.disconnect() })
        chameleon.verboseLog(`port connected, path = ${pluginOption.path}, baudRate = ${pluginOption.baudRate as number}`)
        const chameleonPort = Duplex.toWeb(this.port) as Partial<ChameleonSerialPort<Buffer, Buffer>>
        chameleonPort.isOpen = () => { return this.port?.isOpen ?? false }
        chameleon.port = chameleonPort as any satisfies ChameleonSerialPort<Buffer, Buffer>
        return await next()
      } catch (err) {
        chameleon.verboseLog(err)
        throw err
      }
    })

    chameleon.addHook('disconnect', async (ctx: any, next: () => Promise<unknown>) => {
      if (chameleon.$adapter !== adapter) return await next() // 代表已經被其他 adapter 接管

      await next()
      if (_.isNil(this.port)) return
      await new Promise<void>((resolve, reject) => { this.port?.close(err => { _.isNil(err) ? resolve() : reject(err) }) })
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
