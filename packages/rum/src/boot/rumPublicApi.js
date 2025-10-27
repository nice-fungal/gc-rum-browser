import {
  makePublicApi,
  createContextManager,
  CustomerDataType,
  clocksNow,
  ActionType,
  ResourceType,
  deepClone,
  createHandlingStack,
  sanitizeUser,
  checkUser,
  callMonitored,
  assign,
  monitor,
  storeContextManager,
  createIdentityEncoder,
  addTelemetryUsage,
  sanitize,
  createCustomerDataTrackerManager,
  CustomerDataCompressionStatus,
  displayAlreadyInitializedError,
  getType,
  noop
} from '@cloudcare/browser-core'
import { buildCommonContext } from '../domain/contexts/commonContext'
import { callPluginsMethod } from '../domain/plugins'
import { createPreStartStrategy } from './perStartRum'
import { createResourceTrackerManager } from '../domain/rumEventsCollection/resource/resourceTrackerManager'
import {
  startVisitorId,
  VISITOR_ID_CONTEXT_KEY
} from '../domain/visitorId'
var RUM_STORAGE_KEY = 'rum'
export function makeRumPublicApi(startRumImpl, recorderApi, options) {
  if (options === undefined) {
    options = {}
  }
  var startVisitorIdImpl = options.startVisitorId || startVisitorId
  const customerDataTrackerManager = createCustomerDataTrackerManager(
    CustomerDataCompressionStatus.Unknown
  )
  const resourceTrackerManager = createResourceTrackerManager()
  const globalContextManager = createContextManager('global', {
    customerDataTracker: customerDataTrackerManager.getOrCreateTracker(
      CustomerDataType.GlobalContext
    )
  })
  const userContextManager = createContextManager('user', {
    customerDataTracker: customerDataTrackerManager.getOrCreateTracker(
      CustomerDataType.User
    ),
    propertiesConfig: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' }
    }
  })
  var visitorId = {
    getId: noop,
    reset: noop,
    stop: noop
  }
  function getGlobalContext() {
    var context = globalContextManager.getContext()
    var currentVisitorId = visitorId.getId()
    if (currentVisitorId) {
      context[VISITOR_ID_CONTEXT_KEY] = currentVisitorId
    }
    return context
  }
  function getCommonContext() {
    var commonContext = buildCommonContext(
      globalContextManager,
      userContextManager,
      recorderApi
    )
    var currentVisitorId = visitorId.getId()
    if (currentVisitorId) {
      commonContext.context[VISITOR_ID_CONTEXT_KEY] = currentVisitorId
      // Keep the SDK value separate from customer fields in buffered snapshots.
      commonContext.visitorId = currentVisitorId
    }
    return commonContext
  }
  let strategy
  function addPluginError(providedError) {
    callMonitored(function () {
      providedError = providedError || {}
      strategy.addError(
        assign({}, providedError, {
          context: sanitize(providedError.context)
        }),
        getCommonContext()
      )
      addTelemetryUsage({ feature: 'add-error' })
    })
  }
  strategy = createPreStartStrategy(
    assign({}, options, {
      resourceTrackerManager: resourceTrackerManager,
      onInit: function (initConfiguration, publicApi) {
        callPluginsMethod(initConfiguration.plugins, 'onInit', {
          addError: addPluginError,
          publicApi: publicApi,
          rum: publicApi,
          initConfiguration: initConfiguration
        })
      },
      onConfigurationReady: function (configuration) {
        visitorId.stop()
        visitorId = startVisitorIdImpl(configuration)
      }
    }),
    getCommonContext,
    function doStartRum(configuration, compressionWorker, initialViewOptions) {
      if (configuration.storeContextsToLocal) {
        storeContextManager(
          configuration,
          globalContextManager,
          RUM_STORAGE_KEY,
          CustomerDataType.GlobalContext
        )
        storeContextManager(
          configuration,
          userContextManager,
          RUM_STORAGE_KEY,
          CustomerDataType.User
        )
      }
      customerDataTrackerManager.setCompressionStatus(
        compressionWorker
          ? CustomerDataCompressionStatus.Enabled
          : CustomerDataCompressionStatus.Disabled
      )
      var startRumResult = startRumImpl(
        configuration,
        recorderApi,
        customerDataTrackerManager,
        getCommonContext,
        initialViewOptions,
        compressionWorker && options.createCompressionEncoder
          ? function (streamId) {
              return options.createCompressionEncoder(
                compressionWorker,
                streamId
              )
            }
          : createIdentityEncoder,
        resourceTrackerManager
      )
      // recorderApi.onRumStart(
      //   startRumResult.lifeCycle,
      //   configuration,
      //   startRumResult.session,
      //   startRumResult.viewContexts,
      //   deflateWorker
      // )

      strategy = createPostStartStrategy(strategy, startRumResult)

      callPluginsMethod(configuration.plugins, 'onRumStart', {
        addError: addPluginError,
        publicApi: rumPublicApi,
        rum: rumPublicApi
      })

      return startRumResult
    }
  )

  const startView = monitor(function (options) {
    const sanitizedOptions =
      typeof options === 'object' ? options : { name: options }
    strategy.startView(sanitizedOptions)
    if (sanitizedOptions.context) {
      customerDataTrackerManager
        .getOrCreateTracker(CustomerDataType.View)
        .updateCustomerData(sanitizedOptions.context)
    }
    addTelemetryUsage({ feature: 'start-view' })
  })

  const recorderPublicApi = options.makeRecorderPublicApi
    ? options.makeRecorderPublicApi(recorderApi)
    : {}

  var rumPublicApi = makePublicApi(assign({
    init: monitor(function (initConfiguration) {
      strategy.init(initConfiguration, rumPublicApi)
    }),
    setViewName: monitor((name) => {
      strategy.setViewName(name)
      addTelemetryUsage({ feature: 'set-view-name' })
    }),

    setViewContext: monitor((context) => {
      strategy.setViewContext(context)
      addTelemetryUsage({ feature: 'set-view-context' })
    }),

    setViewContextProperty: monitor((key, value) => {
      strategy.setViewContextProperty(key, value)
      addTelemetryUsage({ feature: 'set-view-context-property' })
    }),

    getViewContext: monitor(() => {
      addTelemetryUsage({ feature: 'set-view-context-property' })
      return strategy.getViewContext()
    }),
    // /** @deprecated: use setGlobalContextProperty instead */
    // addRumGlobalContext: monitor(function (key, value) {
    //   globalContextManager.setContextProperty(key, value)
    //   addTelemetryUsage({ feature: 'set-global-context' })
    // }),
    setGlobalContextProperty: monitor(function (key, value) {
      globalContextManager.setContextProperty(key, value)
      addTelemetryUsage({ feature: 'set-global-context' })
    }),

    // /** @deprecated: use removeGlobalContextProperty instead */
    // removeRumGlobalContext: monitor(function (key) {
    //   return globalContextManager.removeContextProperty(key)
    // }),
    removeGlobalContextProperty: monitor(function (key) {
      return globalContextManager.removeContextProperty(key)
    }),

    // /** @deprecated: use getGlobalContext instead */
    // getRumGlobalContext: monitor(function () {
    //   return getGlobalContext()
    // }),
    getGlobalContext: monitor(function () {
      return getGlobalContext()
    }),

    // /** @deprecated: use setGlobalContext instead */
    // setRumGlobalContext: monitor(function (context) {
    //   globalContextManager.setContext(context)
    //   addTelemetryUsage({ feature: 'set-global-context' })
    // }),
    setGlobalContext: monitor(function (context) {
      globalContextManager.setContext(context)
      addTelemetryUsage({ feature: 'set-global-context' })
    }),

    clearGlobalContext: monitor(function () {
      return globalContextManager.clearContext()
    }),
    resetVisitorId: monitor(function () {
      visitorId.reset()
      addTelemetryUsage({ feature: 'reset-visitor-id' })
    }),

    getInitConfiguration: monitor(function () {
      return deepClone(strategy.initConfiguration)
    }),
    getRemoteConfiguration: monitor(function (callback) {
      return strategy.getRemoteConfiguration(callback)
    }),
    getInternalContext: monitor(function (startTime) {
      return strategy.getInternalContext(startTime)
    }),
    addDebugSession: monitor(function (id) {}),
    clearDebugSession: monitor(function () {}),
    getDebugSession: monitor(function () {}),
    addResource: monitor(function (context) {
      const handlingStack = createHandlingStack()
      callMonitored(function () {
        strategy.addResource({
          context: sanitize(context),
          startClocks: clocksNow(),
          type: ResourceType.CUSTOM,
          handlingStack: handlingStack
        })
        addTelemetryUsage({ feature: 'add-resource' })
      })
    }),
    addTypeAction: monitor(function (name, type, context) {
      const handlingStack = createHandlingStack()

      callMonitored(function () {
        const sourceType = sanitize(type)
        strategy.addAction({
          name: sanitize(name),
          context: sanitize(context),
          startClocks: clocksNow(),
          type:
            getType(sourceType) === 'string' ? sourceType : ActionType.CUSTOM,
          handlingStack: handlingStack
        })
        addTelemetryUsage({ feature: 'add-type-action' })
      })
    }),
    addAction: monitor(function (name, context) {
      const handlingStack = createHandlingStack()
      callMonitored(function () {
        strategy.addAction({
          name: sanitize(name),
          context: sanitize(context),
          startClocks: clocksNow(),
          type: ActionType.CUSTOM,
          handlingStack: handlingStack
        })
        addTelemetryUsage({ feature: 'add-action' })
      })
    }),
    addError: monitor(function (error, context) {
      var handlingStack = createHandlingStack()
      callMonitored(function () {
        strategy.addError({
          error, // Do not sanitize error here, it is needed unserialized by computeRawError()
          handlingStack,
          context: sanitize(context),
          startClocks: clocksNow()
        })
        addTelemetryUsage({ feature: 'add-error' })
      })
    }),
    addTiming: monitor(function (name, time) {
      strategy.addTiming(sanitize(name), time)
    }),
    setUser: monitor(function (newUser) {
      if (checkUser(newUser)) {
        userContextManager.setContext(sanitizeUser(newUser))
      }
      addTelemetryUsage({ feature: 'set-user' })
    }),
    getUser: monitor(function () {
      return userContextManager.getContext()
    }),
    setUserProperty: monitor(function (key, property) {
      var newUser = {}
      newUser[key] = property
      var sanitizedProperty = sanitizeUser(newUser)[key]
      userContextManager.setContextProperty(key, sanitizedProperty)
      addTelemetryUsage({ feature: 'set-user' })
    }),
    removeUserProperty: monitor(function (key) {
      return userContextManager.removeContextProperty(key)
    }),

    // /** @deprecated: renamed to clearUser */
    // removeUser: monitor(function () {
    //   return userContextManager.clearContext()
    // }),
    clearUser: monitor(function () {
      return userContextManager.clearContext()
    }),
    startView: startView,
    stopSession: monitor(function () {
      strategy.stopSession()
      addTelemetryUsage({ feature: 'stop-session' })
    }),
    // startSessionReplayRecording: monitor(function (options) {
    //   recorderApi.start(options)
    //   addTelemetryUsage({
    //     feature: 'start-session-replay-recording',
    //     force: options && options.force
    //   })
    // }),
    // stopSessionReplayRecording: monitor(recorderApi.stop)
  })
  return rumPublicApi
}
function createPostStartStrategy(preStartStrategy, startRumResult) {
  return assign(
    {
      init: function (initConfiguration) {
        displayAlreadyInitializedError('DATAFLUX_RUM', initConfiguration)
      },
      initConfiguration: preStartStrategy.getInitConfiguration(),
      getRemoteConfiguration: function (callback) {
        preStartStrategy.getRemoteConfiguration(callback)
      }
    },
    startRumResult
  )
}
