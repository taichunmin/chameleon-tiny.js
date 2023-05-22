import _ from 'lodash'
import { Chameleon } from '../Chameleon'
import ChameleonSerialPortAdapter from '../plugin/SerialPortAdapter'

async function main (): Promise<void> {
  const chameleon = new Chameleon(console.log) //
  const path = process.env.SERIAL_PATH
  if (_.isNil(path)) throw new Error('env.SERIAL_PATH is not defined')
  console.log(`path = ${path}`)
  await chameleon.use(new ChameleonSerialPortAdapter(), { path })

  // console.log(JSON.stringify(await chameleon.cmdVersion()))
  // await chameleon.cmdSetting(`${_.random(1, 8)}`)
  // console.log(JSON.stringify(await chameleon.cmdSetting()))
  // console.log(JSON.stringify(await chameleon.cmdUid()))
  // console.log(JSON.stringify(await chameleon.cmdGetConfig()))
  // console.log(JSON.stringify(await chameleon.cmdExecHelp()))
  console.log((await chameleon.cmdExecDownload()).toString('base64url'))

  process.exit(0)
}

// run `serialport-list -f jsonline` to list port, see https://serialport.io/docs/bin-list
// SERIAL_PATH='/dev/tty.usbserial-120' node examples/serialport.js
main().catch(err => {
  console.error(err)
  process.exit(1)
})
