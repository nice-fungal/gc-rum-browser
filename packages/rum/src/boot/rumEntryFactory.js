import { defineGlobal, getGlobalObject, monitorError, callMonitored } from '@cloudcare/browser-core'
import { startRum } from './rum'
import { makeRumPublicApi } from './rumPublicApi'
import { makeDisabledRumPublicApi } from './disabledRumPublicApi'

export function makeRumEntry(createRecorderApi, options) {
  var datafluxRum
  try {
    datafluxRum = makeRumPublicApi(startRum, createRecorderApi(), options)
  } catch (error) {
    datafluxRum = makeDisabledRumPublicApi(!!(options && options.makeRecorderPublicApi))
    monitorError(error)
  }
  callMonitored(function () {
    defineGlobal(getGlobalObject(), 'DATAFLUX_RUM', datafluxRum)
  })
  return datafluxRum
}
