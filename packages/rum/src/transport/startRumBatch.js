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
  let initialViewBatch
  let initialViewEncoder
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
      if (serverRumEvent.type === RumEventType.VIEW) {
        batch.upsert(serverRumEvent, serverRumEvent.view.id)
      } else {
        batch.add(serverRumEvent)
      }
    }
  )
  const initialViewSubscription = lifeCycle.subscribe(
    LifeCycleEventType.RUM_VIEW_FIRST_COLLECTED,
    function (event) {
      if (!initialViewBatch) {
        initialViewEncoder = createEncoder(EncoderStreamId.RUM_INITIAL_VIEW)
        initialViewBatch = startBatchWithReplica(
          configuration,
          {
            request,
            encoder: initialViewEncoder,
            encoderFallback: initialViewEncoder.isAsync
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
      // Send the first eligible version separately. The normal batch retains
      // each View's latest version for its original deadline and exit beacon,
      // including rapid routes whose first fetches have not completed yet.
      initialViewBatch.upsert(event, event.view.id)
      flushRequestObservable.notify('view_created')
    }
  )
  const telemetrySubscription = telemetryEventObservable.subscribe(function (event) {
    batch.add(event)
  })
  return {
    flushObservable: batch.flushObservable,
    add: batch.add,
    upsert: batch.upsert,
    stop: function () {
      rumEventSubscription.unsubscribe()
      initialViewSubscription.unsubscribe()
      telemetrySubscription.unsubscribe()
      batch.stop()
      if (initialViewBatch) {
        initialViewBatch.stop()
        if (initialViewEncoder.stop) {
          initialViewEncoder.stop()
        }
      }
    }
  }
}
