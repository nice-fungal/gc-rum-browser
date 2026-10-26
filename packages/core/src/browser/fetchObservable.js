import { instrumentMethod } from '../helper/instrumentMethod'
import { Observable } from '../helper/observable'
import { clocksNow, assign } from '../helper/tools'
import { monitor } from '../helper/monitor'
import { normalizeUrl } from '../helper/urlPolyfill'

var fetchObservable

export function isRequest(input) {
  if (typeof Request === 'undefined' || !input || typeof input !== 'object') {
    return false
  }
  if (input instanceof Request) {
    return true
  }
  try {
    // A native getter checks the Request's internal brand across iframe realms.
    // Unlike toStringTag or duck typing, this does not trust caller properties.
    Object.getOwnPropertyDescriptor(Request.prototype, 'url').get.call(input)
    return true
  } catch (error) {
    return false
  }
}

export function initFetchObservable() {
  if (!fetchObservable) {
    fetchObservable = createFetchObservable()
  }
  return fetchObservable
}
export function resetFetchObservable() {
  fetchObservable = undefined
}
function createFetchObservable() {
  return new Observable(function (observable) {
    if (!window.fetch) {
      return
    }

    var fetchMethod = instrumentMethod(
      window,
      'fetch',
      function (call) {
        return beforeSend(call, observable)
      },
      {
        computeHandlingStack: true
      }
    )
    return fetchMethod.stop
  })
}

function beforeSend(params, observable) {
  var parameters = params.parameters
  var onPostCall = params.onPostCall
  var handlingStack = params.handlingStack
  var input = parameters[0]
  var init = parameters[1]
  var requestInput = isRequest(input)
  var methodFromParams = init && init.method

  if (methodFromParams === undefined && requestInput) {
    methodFromParams = input.method
  }

  var method =
    methodFromParams !== undefined
      ? String(methodFromParams).toUpperCase()
      : 'GET'
  var url = requestInput ? input.url : normalizeUrl(String(input))

  var startClocks = clocksNow()

  var context = {
    state: 'start',
    init: init,
    input: input,
    method: method,
    startClocks: startClocks,
    url: url,
    handlingStack: handlingStack
  }

  observable.notify(context)
  parameters[0] = context.input
  parameters[1] = context.init
  onPostCall(function (responsePromise) {
    return afterSend(observable, responsePromise, context)
  })
}

function afterSend(observable, responsePromise, startContext) {
  var context = startContext
  var reportFetch = function (partialContext) {
    context.state = 'resolve'
    assign(context, partialContext)
    // context.duration = elapsed(context.startClocks.timeStamp, timeStampNow())
    // if ('stack' in response || response instanceof Error) {
    //   context.status = 0
    //   context.isAborted =
    //     response instanceof DOMException &&
    //     response.code === DOMException.ABORT_ERR
    //   context.error = response
    // } else if ('status' in response) {
    //   context.response = response
    //   try {
    //     context.responseType =
    //       (response.constructor === Response && response.type) || '' // issue The Response type getter can only be used on instances of Response
    //   } catch (err) {
    //     context.responseType = ''
    //   }

    //   context.status = response.status
    //   context.isAborted = false
    // }
    observable.notify(context)
  }
  responsePromise.then(
    monitor(function (response) {
      var responseType = ''
      try {
        responseType =
          (response.constructor === Response && response.type) || '' // issue The Response type getter can only be used on instances of Response
      } catch (err) {
        responseType = ''
      }
      reportFetch({
        response: response,
        responseType: responseType,
        status: response.status,
        isAborted: false
      })
    }),
    monitor(function (error) {
      reportFetch({
        status: 0,
        isAborted:
          (context.init &&
            context.init.signal &&
            context.init.signal.aborted) ||
          (error instanceof DOMException &&
            error.code === DOMException.ABORT_ERR),
        error: error
      })
    })
  )
}
