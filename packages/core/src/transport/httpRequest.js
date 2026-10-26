import {
  drainQueuedPayloads,
  getPendingPayloadsBytesCount,
  isPayloadValid,
  newRetryState,
  sendWithRetryStrategy
} from './sendWithRetryStrategy'
import { addEventListener } from '../browser/addEventListener'
import { monitor } from '../helper/monitor'
import { WeakSet } from '../helper/polyfills'
import { addTelemetryError } from '../telemetry/telemetry'
/**
 * Use POST request without content type to:
 * - avoid CORS preflight requests
 * - allow usage of sendBeacon
 *
 * multiple elements are sent separated by \n in order
 * to be parsed correctly without content type header
 */
function addBatchPrecision(url, encoding) {
  if (!url) return url
  url = url + (url.indexOf('?') === -1 ? '?' : '&') + 'precision=ms'
  if (encoding) {
    url = url + '&encoding=' + encoding
  }
  return url
}
export function createHttpRequest(
  endpointUrl,
  bytesLimit,
  retryMaxSize,
  reportError
) {
  if (retryMaxSize === undefined) {
    retryMaxSize = -1
  }
  var retryState = newRetryState(retryMaxSize)
  var exitAcceptedPayloads = new WeakSet()
  var sendStrategyForRetry = function (payload, onResponse) {
    return fetchStrategyWithFallback(endpointUrl, payload, onResponse)
  }
  var sendWithRetry = function (payload) {
    sendWithRetryStrategy(
      payload,
      retryState,
      sendStrategyForRetry,
      endpointUrl,
      reportError
    )
  }

  function sendOnExitWithBudget(bytesBudget, currentPayload) {
    var sentBytesCount = 0
    function trySend(payload) {
      var exitBytesCount = getExitBytesCount(payload)
      if (
        sentBytesCount + exitBytesCount > bytesBudget ||
        !trySendBeacon(endpointUrl, bytesLimit, payload)
      ) {
        return false
      }
      sentBytesCount += exitBytesCount
      exitAcceptedPayloads.add(payload)
      return true
    }
    drainQueuedPayloads(retryState, trySend)
    if (
      currentPayload &&
      isPayloadValid(currentPayload) &&
      !exitAcceptedPayloads.has(currentPayload) &&
      !retryState.$rPayloadSequenceByPayload.has(currentPayload)
    ) {
      if (hasPendingRetryPayloads(retryState) || !trySend(currentPayload)) {
        // Keep the regular transport and its ordered retry queue as the owner
        // when beacon cannot accept this payload. Do not lose the current tail.
        sendWithRetry(currentPayload)
      }
    }
    return sentBytesCount
  }

  return {
    send: sendWithRetry,
    /**
     * Since fetch keepalive behaves like regular fetch on Firefox,
     * keep using sendBeaconStrategy on exit
     */
    sendOnExit: function (payload, bytesBudget) {
      var hasBytesBudget =
        typeof bytesBudget === 'number' &&
        isFinite(bytesBudget) &&
        bytesBudget >= 0
      if (!hasBytesBudget) {
        if (
          payload.$rEnforceOrder &&
          hasPendingRetryPayloads(retryState)
        ) {
          // Hidden/frozen pages can resume. Do not let their newest replay
          // segment bypass an older ordered fetch/retry: once beaconed, that
          // dependent tail could not be withdrawn if the older segment is
          // permanently rejected later.
          sendWithRetry(payload)
          return
        }
        sendBeaconStrategy(endpointUrl, bytesLimit, payload)
        return
      }

      var sentBytesCount = sendOnExitWithBudget(bytesBudget, payload)
      return {
        $rBytesCount: sentBytesCount,
        $rCurrentPayloadSent: exitAcceptedPayloads.has(payload),
        $rPending: retryState.$rPayloadSequenceByPayload.has(payload)
      }
    },
    // Session Replay calls this explicitly on UNLOADING so retry payloads are
    // promoted even when there is no current segment to pass to sendOnExit().
    $rDrainOnExit: function (bytesBudget) {
      var hasBytesBudget =
        typeof bytesBudget === 'number' &&
        isFinite(bytesBudget) &&
        bytesBudget >= 0
      if (!hasBytesBudget) {
        return {
          $rBytesCount: 0,
          $rAllPayloadsSent: false
        }
      }

      var sentBytesCount = sendOnExitWithBudget(bytesBudget)
      var pending = hasPendingRetryPayloads(retryState)
      return {
        $rBytesCount: sentBytesCount,
        $rAllPayloadsSent: !pending,
        $rPending: pending
      }
    },
    $rPendingBytes: function () {
      return getPendingPayloadsBytesCount(retryState)
    }
  }
}

function hasPendingRetryPayloads(retryState) {
  return (
    retryState.queuedPayloads.size() > 0 ||
    retryState.$rOngoingRequests.size > 0
  )
}

function getExitBytesCount(payload) {
  var bytesCount =
    payload && typeof payload.$rExitBytesCount === 'number'
      ? payload.$rExitBytesCount
      : payload && payload.bytesCount
  return typeof bytesCount === 'number' && isFinite(bytesCount)
    ? Math.max(bytesCount, 0)
    : 0
}

function sendBeaconStrategy(endpointUrl, bytesLimit, payload) {
  if (!trySendBeacon(endpointUrl, bytesLimit, payload)) {
    sendXHR(addBatchPrecision(endpointUrl, payload.encoding), payload)
  }
}

function trySendBeacon(endpointUrl, bytesLimit, payload) {
  var data = payload.data
  var bytesCount = payload.bytesCount
  var url = addBatchPrecision(endpointUrl, payload.encoding)
  var canUseBeacon = !!navigator.sendBeacon && bytesCount < bytesLimit
  if (canUseBeacon) {
    try {
      var beaconData
      if (payload.type) {
        beaconData = new Blob([data], {
          type: payload.type
        })
      } else {
        beaconData = data
      }

      var isQueued = navigator.sendBeacon(url, beaconData)

      if (isQueued) {
        return true
      }
    } catch (e) {
      reportBeaconError(e)
    }
  }
  return false
}
var hasReportedBeaconError = false

function reportBeaconError(e) {
  if (!hasReportedBeaconError) {
    hasReportedBeaconError = true
    addTelemetryError(e)
  }
}
export function fetchStrategyWithFallback(
  endpointUrl,
  payload,
  onResponse
) {
  var url = addBatchPrecision(endpointUrl, payload.encoding)
  if (typeof fetch === 'function') {
    return sendFetch(url, payload, onResponse)
  } else {
    return sendXHR(url, payload, onResponse)
  }
}

function sendXHR(url, payload, onResponse) {
  const data = payload.data
  const request = new XMLHttpRequest()
  request.open('POST', url, true)
  if (data instanceof Blob) {
    request.setRequestHeader('Content-Type', data.type)
  } else if (payload.type) {
    request.setRequestHeader('Content-Type', payload.type)
  }
  request.setRequestHeader('x-client-timestamp', Date.now().toString())
  addEventListener(
    request,
    'loadend',
    function () {
      if (typeof onResponse === 'function') {
        onResponse({ status: request.status })
      }
    },
    {
      once: true
    }
  )
  request.send(data)
  return request
}
function sendFetch(url, payload, onResponse) {
  const controller =
    typeof AbortController === 'function' && new AbortController()
  const fetchOption = {
    method: 'POST',
    body: payload.data,
    mode: 'cors'
  }
  const headers = {
    'x-client-timestamp': Date.now().toString()
  }
  if (payload.type) {
    headers['Content-Type'] = payload.type
  }
  if (payload.$rKeepalive) {
    fetchOption.keepalive = true
  }
  fetchOption.headers = headers
  if (controller) {
    fetchOption.signal = controller.signal
  }

  fetch(url, fetchOption)
    .then(
      monitor(function (response) {
        if (typeof onResponse === 'function') {
          onResponse({ status: response.status, type: response.type })
        }
      })
    )
    .catch(
      monitor(function () {
        if (typeof onResponse === 'function') {
          onResponse({ status: 0 })
        }
      })
    )
  if (controller) {
    return controller
  }
}
