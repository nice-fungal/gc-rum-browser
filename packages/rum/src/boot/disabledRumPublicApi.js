// A construction failure happens before init(), so its monitor cannot help.
// Keep this fallback free of runtime collectors and browser instrumentation.
export function makeDisabledRumPublicApi(withReplay) {
  function noop() {}
  function emptyContext() { return {} }
  var api = {}
  var methods = [
    'init', 'setViewName', 'setViewContext', 'setViewContextProperty',
    'addRumGlobalContext', 'setGlobalContextProperty', 'removeRumGlobalContext',
    'removeGlobalContextProperty', 'setRumGlobalContext', 'setGlobalContext',
    'clearGlobalContext', 'resetVisitorId', 'getInitConfiguration',
    'getInternalContext', 'addDebugSession', 'clearDebugSession', 'getDebugSession',
    'addResource', 'addTypeAction', 'addAction', 'addError', 'addTiming', 'setUser',
    'setUserProperty', 'removeUserProperty', 'removeUser', 'clearUser', 'startView',
    'stopSession', 'startSession', 'setForcedSession', 'setResourceContext',
    'appendResourceContext', 'finishResource', 'getResource'
  ]
  // if (withReplay) {
  //   methods = methods.concat([
  //     'startSessionReplayRecording', 'stopSessionReplayRecording',
  //     'takeSubsequentFullSnapshot', 'getSerializedNodeIdForDebug',
  //     'getLastAutoCanvasSnapshotResultForDebug', 'getAutoCanvasSnapshotDebugHistoryForDebug',
  //     'getLastCanvasMutationForDebug', 'getCanvasMutationHistoryForDebug',
  //     'getLastDomMutationForDebug', 'getDomMutationHistoryForDebug',
  //     'getLastReplaySegmentFlushForDebug', 'getReplaySegmentFlushHistoryForDebug',
  //     'getReplayPerformanceForDebug', 'flushReplayMutationsForDebug'
  //   ])
  //   api.isRecording = function () { return false }
  //   api.snapshotCanvas = function () {
  //     return Promise.resolve({ ok: false, reason: 'not_recording' })
  //   }
  // }
  methods.forEach(function (name) { api[name] = noop })
  api.getGlobalContext = api.getRumGlobalContext = api.getViewContext = api.getUser = emptyContext
  api.createResourceTrackerId = function () { return '' }
  api.getRemoteConfiguration = noop
  api.onReady = function (callback) { callback() }
  return api
}
