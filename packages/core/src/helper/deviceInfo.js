import { monitor } from '../helper/monitor'

function getBrowserWindow() {
  return typeof window !== 'undefined' ? window : undefined
}

function getNavigator() {
  const browserWindow = getBrowserWindow()
  return browserWindow && typeof browserWindow.navigator !== 'undefined'
    ? browserWindow.navigator
    : {}
}

function getUserAgent() {
  return getNavigator().userAgent || ''
}

var HIGH_ENTROPY_VALUES_TIMEOUT = 100

function applyWindowsPlatformVersion(deviceInfo, platformVersion) {
  if (typeof platformVersion !== 'string') {
    return
  }
  var majorPlatformVersionString = platformVersion.split('.')[0]
  if (!/^\d+$/.test(majorPlatformVersionString)) {
    return
  }
  var majorPlatformVersion = parseInt(majorPlatformVersionString, 10)
  if (majorPlatformVersion >= 13) {
    deviceInfo.osVersion = '11'
    deviceInfo.osVersionMajor = '11'
  }
}

function getTarget(target, context) {
  return target || context || {}
}

var VariableLibrary = {
  get navigator() {
    return getNavigator()
  },
}
// 方法库
var MethodLibrary = {
  getNetwork: monitor(function () {
    var browserWindow = getBrowserWindow()
    if (!browserWindow || !browserWindow.navigator) {
      return 'unknown'
    }
    var connection =
      browserWindow.navigator.connection ||
      browserWindow.navigator.mozConnection ||
      browserWindow.navigator.webkitConnection
    var result = 'unknown'
    var type = connection ? connection.type || connection.effectiveType : null
    if (type && typeof type === 'string') {
      switch (type) {
        // possible type values
        case 'bluetooth':
        case 'cellular':
          result = 'cellular'
          break
        case 'none':
          result = 'none'
          break
        case 'ethernet':
        case 'wifi':
        case 'wimax':
          result = 'wifi'
          break
        case 'other':
        case 'unknown':
          result = 'unknown'
          break
        // possible effectiveType values
        case 'slow-2g':
        case '2g':
        case '3g':
          result = 'cellular'
          break
        case '4g':
          result = 'wifi'
          break
        default:
          break
      }
    }
    return result
  }),
  getLanguage: monitor(function (target) {
    var _this = getTarget(target, this)
    _this.language = (function () {
      var navigator = getNavigator()
      var language =
        navigator.browserLanguage || navigator.language || ''
      var arr = language.split('-')
      if (arr[1]) {
        arr[1] = arr[1].toUpperCase()
      }
      return arr.join('_')
    })()
    return _this.language
  }),
  getTimeZone: monitor(function () {
    try {
      const intl = new Intl.DateTimeFormat()

      return intl.resolvedOptions().timeZone
    } catch {
      return undefined
    }
  }),
}

export function getDeviceInfo() {
  return {
    screenSize: screen.width + '*' + screen.height,
    networkType: MethodLibrary.getNetwork(),
    timeZone: MethodLibrary.getTimeZone(),
    userAgent: getUserAgent()
  }
}

export function getDeviceInfoWithHighEntropyValues(callback) {
  const currentDeviceInfo = getDeviceInfo()
  callback(currentDeviceInfo)
}

export var deviceInfo = getDeviceInfo()
