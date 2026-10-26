import { startRecording } from './startRecording'
import { makeRecorderApi } from './recorderApi'
import { createDeflateEncoder, startDeflateWorker } from '../domain/deflate'
import { makeRumEntry } from './rumEntryFactory'
import { makeSessionReplayPublicApi } from './sessionReplayPublicApi'
export var datafluxRum = makeRumEntry(function () {
  return makeRecorderApi(startRecording)
}, {
  startCompressionWorker: startDeflateWorker,
  createCompressionEncoder: createDeflateEncoder,
  makeRecorderPublicApi: makeSessionReplayPublicApi
})
