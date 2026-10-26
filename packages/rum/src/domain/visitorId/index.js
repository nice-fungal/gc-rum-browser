import {
  DOM_EVENT,
  ONE_HOUR,
  UUID,
  WeakSet,
  addEventListener,
  display,
  getOrigin,
  initFetchObservable,
  initXhrObservable,
  isRequest,
  noop,
  normalizeUrl,
  shallowClone,
  timeStampNow
} from '@cloudcare/browser-core'
import { isAllowedRequestUrl } from '../rumEventsCollection/resource/resourceUtils'
import { createRandomHexIdentifier } from '../tracing/traceIdentifier'

export var VISITOR_ID_CONTEXT_KEY = 'visitor_id'
export var VISITOR_ID_STORAGE_KEY = '_gc_visitor_id'
export var DEFAULT_VISITOR_ID_TTL_HOURS = 24

var PERSISTENT_ID_PREFIX = 'p'
var SESSION_ID_PREFIX = 's'
var VISITOR_ID_PATTERN = /^[ps][0-9a-f]{32}$/
var FETCH_INIT_FIELDS = [
  'method', 'headers', 'body', 'referrer', 'referrerPolicy', 'mode',
  'credentials', 'cache', 'redirect', 'integrity', 'keepalive', 'signal',
  'window', 'duplex', 'priority', 'attributionReporting', 'browsingTopics'
]

export function startVisitorId(configuration) {
  if (!configuration.visitorId.enabled) {
    return createVisitorIdStub()
  }

  var manager = createVisitorIdManager(configuration.visitorId)
  var requestCollection = startVisitorIdRequestCollection(
    configuration,
    manager
  )

  return {
    getId: manager.getId,
    reset: manager.reset,
    stop: function () {
      requestCollection.stop()
      manager.stop()
    }
  }
}

export function createVisitorIdManager(visitorIdConfiguration, options) {
  if (options === undefined) {
    options = {}
  }

  var getNow = options.getNow || timeStampNow
  var createIdentifier = options.createIdentifier || createIdentifierValue
  var localStorage = getStorage(options, 'localStorage')
  var sessionStorage = getStorage(options, 'sessionStorage')
  var ttl = visitorIdConfiguration.ttlHours * ONE_HOUR
  var currentRecord = loadOrCreateRecord()
  var storageListener = localStorage
    ? addEventListener(window, DOM_EVENT.STORAGE, function (event) {
        if (event.key !== VISITOR_ID_STORAGE_KEY) {
          return
        }
        if (event.storageArea && event.storageArea !== localStorage) {
          return
        }
        // Storage events may be queued before a later reset in this or another tab.
        // Read the current value instead of replaying the event's stale snapshot.
        var nextRecord = readRecord(
          localStorage,
          PERSISTENT_ID_PREFIX,
          getNow(),
          ttl
        )
        if (
          nextRecord &&
          currentRecord &&
          compareRecords(nextRecord, currentRecord) < 0
        ) {
          return
        }
        currentRecord = nextRecord
      })
    : { stop: noop }

  function loadOrCreateRecord() {
    var now = getNow()
    var persistentRecord = readRecord(
      localStorage,
      PERSISTENT_ID_PREFIX,
      now,
      ttl
    )
    var sessionRecord = readRecord(sessionStorage, SESSION_ID_PREFIX, now, ttl)
    if (sessionRecord && persistentRecord) {
      var order = compareRecords(sessionRecord, persistentRecord)
      return order > 0 ||
        (order === 0 &&
          sessionRecord.revision === undefined &&
          persistentRecord.revision === undefined)
        ? sessionRecord
        : persistentRecord
    }
    if (sessionRecord || persistentRecord) {
      return sessionRecord || persistentRecord
    }

    return createAndPersistRecord(now)
  }

  function createAndPersistRecord(now) {
    var identifier = createIdentifier()
    // Date.now() can return the same value for several resets. Keep their order
    // independently from the TTL timestamp, including when session cleanup fails.
    var revision = 0
    ;[
      currentRecord,
      readRecord(localStorage, PERSISTENT_ID_PREFIX, now, ttl),
      readRecord(sessionStorage, SESSION_ID_PREFIX, now, ttl)
    ].forEach(function (record) {
      if (record && record.createdAt === now) {
        revision = Math.max(revision, (record.revision || 0) + 1)
      }
    })
    var persistentRecord = {
      id: PERSISTENT_ID_PREFIX + identifier,
      createdAt: now,
      revision: revision
    }
    var storedPersistentRecord = writeRecord(
      localStorage,
      persistentRecord,
      PERSISTENT_ID_PREFIX,
      now,
      ttl
    )
    if (storedPersistentRecord) {
      try {
        sessionStorage && sessionStorage.removeItem(VISITOR_ID_STORAGE_KEY)
      } catch (error) {
        // Ordering metadata still supersedes the stale session record.
      }
      return storedPersistentRecord
    }

    var sessionRecord = {
      id: SESSION_ID_PREFIX + identifier,
      createdAt: now,
      revision: revision
    }
    return (
      writeRecord(sessionStorage, sessionRecord, SESSION_ID_PREFIX, now, ttl) ||
      sessionRecord
    )
  }

  function ensureCurrentRecord() {
    var now = getNow()
    if (!isValidRecord(currentRecord, undefined, now, ttl)) {
      currentRecord = loadOrCreateRecord()
    }
    return currentRecord
  }

  return {
    getId: function () {
      return ensureCurrentRecord().id
    },
    reset: function () {
      currentRecord = createAndPersistRecord(getNow())
    },
    stop: storageListener.stop
  }
}

export function startVisitorIdRequestCollection(configuration, manager) {
  var xhrHeaderReservation
  var xhrSubscription = initXhrObservable().subscribe(function (context) {
    if (context.state === 'start') {
      context.visitorId = xhrHeaderReservation.apply(context)
    }
  })
  xhrHeaderReservation = startVisitorIdXhrHeaderReservation(
    configuration,
    manager
  )
  var fetchSubscription = initFetchObservable().subscribe(function (context) {
    if (
      context.state === 'start' &&
      shouldInjectVisitorId(configuration, context.url)
    ) {
      var visitorId = manager.getId()
      if (
        injectVisitorIdIntoFetch(
          context,
          configuration.visitorId.header,
          visitorId
        )
      ) {
        context.visitorId = visitorId
      }
    }
  })

  return {
    stop: function () {
      xhrHeaderReservation.stop()
      xhrSubscription.unsubscribe()
      fetchSubscription.unsubscribe()
    }
  }
}

export function shouldInjectVisitorId(configuration, url) {
  return (
    isAllowedRequestUrl(configuration, url) &&
    matchesVisitorIdUrl(configuration.visitorId.match, url)
  )
}

export function matchesVisitorIdUrl(matchOptions, url) {
  for (var index = 0; index < matchOptions.length; index += 1) {
    var matchOption = matchOptions[index]
    try {
      if (typeof matchOption === 'function' && matchOption(url)) {
        return true
      }
      if (matchOption instanceof RegExp) {
        var matched
        try {
          matchOption.lastIndex = 0
          matched = matchOption.test(url)
        } finally {
          matchOption.lastIndex = 0
        }
        if (matched) {
          return true
        }
      }
      if (
        typeof matchOption === 'string' &&
        url.indexOf(matchOption) === 0 &&
        getOrigin(matchOption) === getOrigin(url)
      ) {
        return true
      }
    } catch (error) {
      display.error('Visitor ID URL matcher threw an error:', error)
    }
  }
  return false
}

function injectVisitorIdIntoFetch(context, header, visitorId) {
  try {
    var originalInit = context.init
    if (
      originalInit != null &&
      typeof originalInit !== 'object' &&
      typeof originalInit !== 'function'
    ) {
      return
    }
    var init = shallowClone(originalInit)
    // RequestInit is a WebIDL dictionary: inherited and non-enumerable fields
    // count too. Materialize them so later tracing instrumentation preserves them.
    FETCH_INIT_FIELDS.forEach(function (field) {
      if (
        originalInit &&
        field in originalInit &&
        !Object.prototype.hasOwnProperty.call(init, field)
      ) {
        init[field] = originalInit[field]
      }
    })
    var headers = new Headers(
      init.headers === undefined && isRequest(context.input)
        ? context.input.headers
        : init.headers
    )
    if (headers.has(header)) {
      displayVisitorIdHeaderOverrideWarning('fetch')
    }
    headers.set(header, visitorId)
    init.headers = headers
    // Avoid constructing a Request here: that can consume the caller's body even
    // if a later header operation fails. Native fetch handles the body once.
    context.init = init
    return true
  } catch (error) {
    display.error('Unable to inject the Visitor ID header into fetch:', error)
  }
}

function startVisitorIdXhrHeaderReservation(configuration, manager) {
  var header = configuration.visitorId.header
  var matchedXhrs = new WeakSet()
  var callerHeaderXhrs = new WeakSet()
  var sentXhrs = new WeakSet()
  var injectedIds = new WeakMap()
  var originalOpen = XMLHttpRequest.prototype.open
  var stopped = false
  var openInstrumentation = function () {
    if (stopped) {
      return originalOpen.apply(this, arguments)
    }
    var xhr = this
    matchedXhrs.delete(xhr)
    callerHeaderXhrs.delete(xhr)
    sentXhrs.delete(xhr)
    injectedIds.delete(xhr)
    try {
      if (
        shouldInjectVisitorId(configuration, normalizeUrl(String(arguments[1])))
      ) {
        matchedXhrs.add(xhr)
      }
    } catch (error) {
      // Let native open() validate the URL and preserve its original exception.
    }
    try {
      // open() synchronously dispatches OPENED; handlers may set headers/send.
      return originalOpen.apply(xhr, arguments)
    } catch (error) {
      matchedXhrs.delete(xhr)
      callerHeaderXhrs.delete(xhr)
      sentXhrs.delete(xhr)
      injectedIds.delete(xhr)
      throw error
    }
  }
  XMLHttpRequest.prototype.open = openInstrumentation
  var originalSend = XMLHttpRequest.prototype.send
  var sendInstrumentation = function () {
    if (stopped || !matchedXhrs.has(this)) {
      return originalSend.apply(this, arguments)
    }
    var xhr = this
    var wasSent = sentXhrs.has(xhr)
    sentXhrs.add(xhr)
    try {
      return originalSend.apply(xhr, arguments)
    } catch (error) {
      // A failed first send leaves the native XHR open for header edits/retry.
      // A failed duplicate send must not reopen an already-sent reservation.
      if (!wasSent) {
        sentXhrs.delete(xhr)
      }
      throw error
    }
  }
  XMLHttpRequest.prototype.send = sendInstrumentation
  var originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader
  var setRequestHeaderInstrumentation = function (name, value) {
    if (
      !stopped &&
      typeof name === 'string' &&
      name.toLowerCase() === header &&
      matchedXhrs.has(this) &&
      !sentXhrs.has(this)
    ) {
      callerHeaderXhrs.add(this)
      return
    }
    return originalSetRequestHeader.apply(this, arguments)
  }
  XMLHttpRequest.prototype.setRequestHeader = setRequestHeaderInstrumentation

  return {
    apply: function (context) {
      var xhr = context.xhr
      if (!matchedXhrs.has(xhr)) {
        return
      }
      if (callerHeaderXhrs.delete(xhr)) {
        displayVisitorIdHeaderOverrideWarning('XHR')
      }
      if (injectedIds.has(xhr)) {
        // Native send() may throw before sending and leave the XHR reusable.
        // Headers cannot be replaced once set, so retain the first injected ID
        // even if resetVisitorId() was called before the retry.
        return injectedIds.get(xhr)
      }

      var visitorId = manager.getId()
      try {
        originalSetRequestHeader.call(xhr, header, visitorId)
        injectedIds.set(xhr, visitorId)
        return visitorId
      } catch (error) {
        display.error(
          'Unable to inject the Visitor ID header into XHR:',
          error
        )
        return
      }
    },
    stop: function () {
      stopped = true
      if (XMLHttpRequest.prototype.open === openInstrumentation) {
        XMLHttpRequest.prototype.open = originalOpen
      }
      if (XMLHttpRequest.prototype.send === sendInstrumentation) {
        XMLHttpRequest.prototype.send = originalSend
      }
      if (
        XMLHttpRequest.prototype.setRequestHeader ===
        setRequestHeaderInstrumentation
      ) {
        XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader
      }
    }
  }
}

function displayVisitorIdHeaderOverrideWarning(requestType) {
  display.warn(
    'Visitor ID header is already set on this ' +
      requestType +
      ' request. It was replaced with the SDK-managed value.'
  )
}

function getStorage(options, storageName) {
  if (Object.prototype.hasOwnProperty.call(options, storageName)) {
    return options[storageName]
  }
  try {
    return window[storageName]
  } catch (error) {
    return undefined
  }
}

function readRecord(storage, expectedPrefix, now, ttl) {
  if (!storage) {
    return undefined
  }
  try {
    return parseRecord(
      storage.getItem(VISITOR_ID_STORAGE_KEY),
      expectedPrefix,
      now,
      ttl
    )
  } catch (error) {
    return undefined
  }
}

function writeRecord(storage, record, expectedPrefix, now, ttl) {
  if (!storage) {
    return undefined
  }
  try {
    storage.setItem(VISITOR_ID_STORAGE_KEY, JSON.stringify(record))
  } catch (error) {
    return undefined
  }

  var storedRecord = readRecord(storage, expectedPrefix, now, ttl)
  return storedRecord &&
    storedRecord.id === record.id &&
    compareRecords(storedRecord, record) === 0
    ? storedRecord
    : undefined
}

function parseRecord(rawRecord, expectedPrefix, now, ttl) {
  if (!rawRecord) {
    return undefined
  }
  try {
    var record = JSON.parse(rawRecord)
    return isValidRecord(record, expectedPrefix, now, ttl) ? record : undefined
  } catch (error) {
    return undefined
  }
}

function isValidRecord(record, expectedPrefix, now, ttl) {
  return (
    !!record &&
    VISITOR_ID_PATTERN.test(record.id) &&
    (!expectedPrefix || record.id.charAt(0) === expectedPrefix) &&
    typeof record.createdAt === 'number' &&
    (record.revision === undefined ||
      (typeof record.revision === 'number' &&
        isFinite(record.revision) &&
        record.revision >= 0 &&
        Math.floor(record.revision) === record.revision)) &&
    record.createdAt <= now &&
    record.createdAt + ttl > now
  )
}

function compareRecords(first, second) {
  return first.createdAt - second.createdAt ||
    (first.revision || 0) - (second.revision || 0)
}

function createIdentifierValue() {
  try {
    return createRandomHexIdentifier(16)
  } catch (error) {
    return UUID().replace(/-/g, '')
  }
}

function createVisitorIdStub() {
  return {
    getId: noop,
    reset: noop,
    stop: noop
  }
}
