// Keep this module dependency-free: collections are also created while modules
// load, before monitor/telemetry or the public API can be initialized.
export var SDKMap = selectMapConstructor()

function selectMapConstructor() {
  var Candidate
  var WeakCandidate
  try {
    Candidate = typeof Map === 'function' ? Map : undefined
    WeakCandidate = typeof WeakMap === 'function' ? WeakMap : undefined
  } catch (_) {
    // A host may expose a throwing global getter.
  }
  return chooseMapConstructor(Candidate, WeakCandidate)
}

// Exported from this file for contract tests, not from the package entry point.
export function chooseMapConstructor(Candidate, WeakCandidate) {
  try {
    var map = new Candidate()
    var key = {}
    if (
      map.set(key, 1) === map && map.get(key) === 1 && map.has(key) &&
      map.set(NaN, 2) === map && map.get(NaN) === 2 &&
      map.set(-0, 3) === map && map.has(0) && map.size === 3 &&
      map.keys().next().value === key &&
      map.values().next().value === 1 &&
      map.entries().next().value[0] === key
    ) {
      var count = 0
      map.forEach(function (value, entryKey, owner) {
        if (owner === map && owner.get(entryKey) === value) count++
      })
      if (count === 3 && map.delete(key) && !map.has(key)) {
        var iterator = map.entries()
        map.clear()
        map.set('after-clear', 4)
        var next = iterator.next()
        if (map.size === 1 && next.value[0] === 'after-clear' && iterator.next().done) {
          // Native fast path: no wrapper around instances or individual calls.
          return Candidate
        }
      }
    }
  } catch (_) {
    // Legacy applications sometimes replace the global Map with a put/get API.
  }
  return createFallbackMap(WeakCandidate)
}

function createFallbackMap(WeakCandidate) {
  var ObjectIndex
  try {
    var weak = new WeakCandidate()
    var frozenKey = Object.freeze({})
    weak.set(frozenKey, 1)
    if (weak.get(frozenKey) === 1 && weak.delete(frozenKey) && weak.get(frozenKey) === undefined) {
      ObjectIndex = WeakCandidate
    }
  } catch (_) {
    // Identity lookup below also works without a usable WeakMap. Never add
    // metadata to customer DOM nodes, frozen objects or other object keys.
  }
  var iteratorSymbol
  try {
    iteratorSymbol = typeof Symbol === 'function' && Symbol.iterator
  } catch (_) {}

  function FallbackMap(entries) {
    this.$rHead = { $rNext: undefined }
    this.$rTail = this.$rHead
    this.$rIndex = Object.create(null)
    this.$rObjects = ObjectIndex ? new ObjectIndex() : undefined
    this.size = 0
    if (entries != null) {
      var iteratorMethod = iteratorSymbol && entries[iteratorSymbol]
      if (iteratorMethod) {
        var iterator = iteratorMethod.call(entries)
        try {
          var step
          while (!(step = iterator.next()).done) addEntry(this, step.value)
        } catch (error) {
          if (typeof iterator.return === 'function') iterator.return()
          throw error
        }
      } else if (Array.isArray(entries)) {
        for (var i = 0; i < entries.length; i++) addEntry(this, entries[i])
      } else {
        throw new TypeError('Map entries must be iterable')
      }
    }
  }
  function addEntry(map, entry) {
    if (!entry || (typeof entry !== 'object' && typeof entry !== 'function')) {
      throw new TypeError('Map entry must be an object')
    }
    map.set(entry[0], entry[1])
  }
  function indexKey(key) {
    var type = typeof key
    if (key !== null && (type === 'object' || type === 'function')) return undefined
    return type === 'symbol' ? key : type + ':' + String(key)
  }
  function find(map, key) {
    var indexedKey = indexKey(key)
    if (indexedKey !== undefined) return map.$rIndex[indexedKey]
    if (map.$rObjects) return map.$rObjects.get(key)
    var node = map.$rHead.$rNext
    while (node) {
      if (node.$rKey === key) return node
      node = node.$rNext
    }
  }
  function advance(map, node) {
    // Iterators survive deletion of their current entry, and clear followed by
    // insertion. Removed entries retain only a backwards link, not key/value.
    while (node.$rRemoved) node = node.$rPrevious
    return node.$rNext
  }
  function makeIterator(map, kind) {
    var current = map.$rHead
    var iterator = {
      next: function () {
        current = current && advance(map, current)
        return current
          ? { done: false, value: kind === 'keys' ? current.$rKey : kind === 'values' ? current.$rValue : [current.$rKey, current.$rValue] }
          : { done: true, value: undefined }
      }
    }
    if (iteratorSymbol) iterator[iteratorSymbol] = function () { return this }
    return iterator
  }
  FallbackMap.prototype.has = function (key) { return !!find(this, key) }
  FallbackMap.prototype.get = function (key) {
    var node = find(this, key)
    return node && node.$rValue
  }
  FallbackMap.prototype.set = function (key, value) {
    var node = find(this, key)
    if (node) {
      node.$rValue = value
    } else {
      node = { $rKey: key === 0 ? 0 : key, $rValue: value, $rPrevious: this.$rTail }
      this.$rTail.$rNext = node
      this.$rTail = node
      var indexedKey = indexKey(key)
      if (indexedKey !== undefined) this.$rIndex[indexedKey] = node
      else if (this.$rObjects) this.$rObjects.set(key, node)
      this.size++
    }
    return this
  }
  FallbackMap.prototype.delete = function (key) {
    var node = find(this, key)
    if (!node) return false
    var indexedKey = indexKey(key)
    if (indexedKey !== undefined) delete this.$rIndex[indexedKey]
    else if (this.$rObjects) this.$rObjects.delete(key)
    node.$rPrevious.$rNext = node.$rNext
    if (node.$rNext) node.$rNext.$rPrevious = node.$rPrevious
    else this.$rTail = node.$rPrevious
    node.$rRemoved = true
    node.$rKey = node.$rValue = node.$rNext = undefined
    this.size--
    return true
  }
  FallbackMap.prototype.clear = function () {
    var node = this.$rHead.$rNext
    while (node) {
      var next = node.$rNext
      node.$rRemoved = true
      node.$rPrevious = this.$rHead
      node.$rKey = node.$rValue = node.$rNext = undefined
      node = next
    }
    this.$rHead.$rNext = undefined
    this.$rTail = this.$rHead
    this.$rIndex = Object.create(null)
    this.$rObjects = ObjectIndex ? new ObjectIndex() : undefined
    this.size = 0
  }
  FallbackMap.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('Map callback must be a function')
    var node = this.$rHead
    while ((node = advance(this, node))) callback.call(thisArg, node.$rValue, node.$rKey, this)
  }
  FallbackMap.prototype.keys = function () { return makeIterator(this, 'keys') }
  FallbackMap.prototype.values = function () { return makeIterator(this, 'values') }
  FallbackMap.prototype.entries = function () { return makeIterator(this, 'entries') }
  if (iteratorSymbol) FallbackMap.prototype[iteratorSymbol] = FallbackMap.prototype.entries
  return FallbackMap
}
