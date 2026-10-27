import {
  createIdentityEncoder,
  createHttpRequest,
  LifeCycleEventType,
  Observable,
  RumEventType,
  startBatchWithReplica
} from '@cloudcare/browser-core'
import { EncoderStreamId } from '../domain/encoderStreamId'
export function startRumBatch(
  configuration,
  lifeCycle,
  telemetryEventObservable,
  reportError,
  pageExitObservable,
  sessionExpireObservable,
  createEncoder
) {
  const rumEncoder = createEncoder(EncoderStreamId.RUM)
  // Both batches share the same retry queue and bandwidth limits.
  const request = createHttpRequest(
    configuration.rumEndpoint,
    configuration.batchBytesLimit,
    configuration.retryMaxSize,
    reportError
  )
  const flushRequestObservable = new Observable()
  let immediateViewBatch
  let immediateViewEncoder
  const batch = startBatchWithReplica(
    configuration,
    {
      endpoint: configuration.rumEndpoint,
      request,
      encoder: rumEncoder,
      encoderFallback: rumEncoder.isAsync
        ? createIdentityEncoder
        : undefined
    },
    reportError,
    pageExitObservable,
    sessionExpireObservable
  )
  const rumEventSubscription = lifeCycle.subscribe(
    LifeCycleEventType.RUM_EVENT_COLLECTED,
    function (serverRumEvent) {
      // NOTE: upsert 和 add 其实是同一个方法；只是 upsert 会根据 key 来覆盖之前的内容
      if (serverRumEvent.type === RumEventType.VIEW) {
        batch.upsert(serverRumEvent, serverRumEvent.view.id)
      } else {
        batch.add(serverRumEvent)
      }
    }
  )
  function sendImmediateView(event, reason) {
    if (!immediateViewBatch) {
      immediateViewEncoder = createEncoder(EncoderStreamId.RUM_INITIAL_VIEW)
      immediateViewBatch = startBatchWithReplica(
        configuration,
        {
          request,
          encoder: immediateViewEncoder,
          encoderFallback: immediateViewEncoder.isAsync
            ? createIdentityEncoder
            : undefined,
          flushRequestObservable
        },
        reportError,
        // The regular batch already owns the exit copy. Do not promote an
        // older first version from this encoder's journal on the same exit.
        new Observable(),
        sessionExpireObservable
      )
    }
    // Send initial and forced-session Views separately. The normal batch retains
    // each View's latest version for its original deadline and exit beacon,
    // including rapid routes whose first fetches have not completed yet.
    immediateViewBatch.upsert(event, event.view.id)
    flushRequestObservable.notify(reason)
  }
  const initialViewSubscription = lifeCycle.subscribe(
    LifeCycleEventType.RUM_VIEW_FIRST_COLLECTED,
    event => sendImmediateView(event, 'view_created')
  )
  const forcedViewSubscription = lifeCycle.subscribe(
    LifeCycleEventType.RUM_VIEW_FORCED_COLLECTED,
    event => sendImmediateView(event, 'session_forced')
  )
  // const telemetrySubscription = telemetryEventObservable.subscribe(function (event) {
  //   batch.add(event)
  // })
  return {
    flushObservable: batch.flushObservable,
    add: batch.add,
    upsert: batch.upsert,
    stop: function () {
      rumEventSubscription.unsubscribe()
      initialViewSubscription.unsubscribe()
      forcedViewSubscription.unsubscribe()
      // telemetrySubscription.unsubscribe()
      batch.stop()
      if (immediateViewBatch) {
        immediateViewBatch.stop()
        if (immediateViewEncoder.stop) {
          immediateViewEncoder.stop()
        }
      }
    }
  }
}
