import { SDKMap } from '@cloudcare/browser-core'
import {
  safeTruncate,
  isIE,
  find,
  map,
  filter,
  getParentElement,
  isNodeShadowRoot
} from '@cloudcare/browser-core'
import {
  getNodePrivacyLevel,
  shouldMaskNode
} from '../../privacy'

export var DEFAULT_PROGRAMMATIC_ACTION_NAME_ATTRIBUTE =
  'data-guance-action-name'
export var ACTION_NAME_PLACEHOLDER = 'Masked Element'

export function getActionNameFromElement(
  element,
  configuration,
  shouldIgnoreTextualFallback,
  nodePrivacyLevel
) {
  configuration = configuration || {}
  var userProgrammaticAttribute = configuration.actionNameAttribute
  var nodePrivacyLevelCache = new SDKMap()
  var explicitActionName = getExplicitActionName(
    element,
    userProgrammaticAttribute
  )

  if (explicitActionName) {
    return explicitActionName
  }
  if (
    configuration.enablePrivacyForActionName &&
    shouldMaskNode(configuration, element, nodePrivacyLevel)
  ) {
    return ACTION_NAME_PLACEHOLDER
  }

  return (
    getActionNameFromElementForStrategies(
      element,
      configuration,
      nodePrivacyLevelCache,
      shouldIgnoreTextualFallback
        ? shadowDomPriorityStrategies
        : priorityStrategies
    ) ||
    (!shouldIgnoreTextualFallback &&
      getActionNameFromElementForStrategies(
        element,
        configuration,
        nodePrivacyLevelCache,
        fallbackStrategies
      )) ||
    ''
  )
}

function getExplicitActionName(element, userProgrammaticAttribute) {
  return (
    getActionNameFromElementProgrammatically(
      element,
      DEFAULT_PROGRAMMATIC_ACTION_NAME_ATTRIBUTE
    ) ||
    (userProgrammaticAttribute &&
      getActionNameFromElementProgrammatically(
        element,
        userProgrammaticAttribute
      ))
  )
}

function getActionNameFromElementProgrammatically(
  targetElement,
  programmaticAttribute
) {
  var elementWithAttribute
  // We don't use getActionNameFromElementForStrategies here, because we want to consider all parents,
  // without limit. It is up to the user to declare a relevant naming strategy.
  var element = targetElement
  while (element) {
    if (element.hasAttribute(programmaticAttribute)) {
      elementWithAttribute = element
      break
    }
    element = getParentElement(element)
  }

  if (!elementWithAttribute) {
    return
  }
  var name = elementWithAttribute.getAttribute(programmaticAttribute)
  return truncate(normalizeWhitespace(name.trim()))
}

var priorityStrategies = [
  // associated LABEL text
  function (element, configuration, nodePrivacyLevelCache) {
    // IE does not support element.labels, so we fallback to a CSS selector based on the element id
    // instead
    if (supportsLabelProperty()) {
      if ('labels' in element && element.labels && element.labels.length > 0) {
        return getTextualContent(
          element.labels[0],
          configuration,
          nodePrivacyLevelCache
        )
      }
    } else if (element.id) {
      var label =
        element.ownerDocument &&
        find(element.ownerDocument.querySelectorAll('label'), function (label) {
          return label.htmlFor === element.id
        })
      return (
        label && getTextualContent(label, configuration, nodePrivacyLevelCache)
      )
    }
  },
  // INPUT button (and associated) value
  function (element) {
    if (element.nodeName === 'INPUT') {
      var input = element
      var type = input.getAttribute('type')
      if (type === 'button' || type === 'submit' || type === 'reset') {
        return input.value
      }
    }
  },
  // BUTTON, LABEL or button-like element text
  function (element, configuration, nodePrivacyLevelCache) {
    if (
      element.nodeName === 'BUTTON' ||
      element.nodeName === 'LABEL' ||
      element.getAttribute('role') === 'button'
    ) {
      return getTextualContent(element, configuration, nodePrivacyLevelCache)
    }
  },
  function (element) {
    return element.getAttribute('aria-label')
  },
  // associated element text designated by the aria-labelledby attribute
  function (element, configuration, nodePrivacyLevelCache) {
    var labelledByAttribute = element.getAttribute('aria-labelledby')
    if (labelledByAttribute) {
      labelledByAttribute = labelledByAttribute.split(/\s+/)
      labelledByAttribute = map(labelledByAttribute, function (id) {
        return getElementById(element, id)
      })
      labelledByAttribute = filter(labelledByAttribute, function (label) {
        return Boolean(label)
      })
      labelledByAttribute = map(labelledByAttribute, function (ele) {
        return getTextualContent(ele, configuration, nodePrivacyLevelCache)
      })
      return labelledByAttribute.join(' ')
    }
  },
  function (element) {
    return element.getAttribute('alt')
  },
  function (element) {
    return element.getAttribute('name')
  },
  function (element) {
    return element.getAttribute('title')
  },
  function (element) {
    return element.getAttribute('placeholder')
  },
  // SELECT first OPTION text
  function (element, configuration, nodePrivacyLevelCache) {
    if ('options' in element && element.options.length > 0) {
      return getTextualContent(
        element.options[0],
        configuration,
        nodePrivacyLevelCache
      )
    }
  }
]

var shadowDomPriorityStrategies = priorityStrategies.concat([
  function (element, configuration, nodePrivacyLevelCache) {
    if (element.nodeName === 'A' && element.hasAttribute('href')) {
      return getTextualContent(element, configuration, nodePrivacyLevelCache)
    }
  }
])

var fallbackStrategies = [
  function (element, configuration, nodePrivacyLevelCache) {
    return getTextualContent(element, configuration, nodePrivacyLevelCache)
  }
]

/**
 * Iterates over the target element and its parent, using the strategies list to get an action name.
 * Each strategies are applied on each element, stopping as soon as a non-empty value is returned.
 */
var MAX_PARENTS_TO_CONSIDER = 10
function getActionNameFromElementForStrategies(
  targetElement,
  configuration,
  nodePrivacyLevelCache,
  strategies
) {
  var element = targetElement
  var recursionCounter = 0
  while (
    recursionCounter <= MAX_PARENTS_TO_CONSIDER &&
    element &&
    element.nodeName !== 'BODY' &&
    element.nodeName !== 'HTML' &&
    element.nodeName !== 'HEAD'
  ) {
    if (configuration.enablePrivacyForActionName) {
      var privacyLevel = getNodePrivacyLevel(
        element,
        configuration.defaultPrivacyLevel,
        nodePrivacyLevelCache
      )
      if (shouldMaskNode(configuration, element, privacyLevel)) {
        return ACTION_NAME_PLACEHOLDER
      }
    }
    for (var i = 0; i < strategies.length; i++) {
      var strategy = strategies[i]
      var name = strategy(element, configuration, nodePrivacyLevelCache)
      if (typeof name === 'string') {
        var trimmedName = name.trim()
        if (trimmedName) {
          return truncate(normalizeWhitespace(trimmedName))
        }
      }
    }
    // Consider a FORM as a contextual limit to get the action name.  This is experimental and may
    // be reconsidered in the future.
    if (element.nodeName === 'FORM') {
      break
    }
    element = getParentElement(element)
    recursionCounter += 1
  }
}

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ')
}

function truncate(s) {
  return s.length > 100 ? safeTruncate(s, 100) + ' [...]' : s
}

function getElementById(refElement, id) {
  if (typeof refElement.getRootNode === 'function') {
    var rootNode = refElement.getRootNode()
    if (
      isNodeShadowRoot(rootNode) &&
      typeof rootNode.getElementById === 'function'
    ) {
      var shadowElement = rootNode.getElementById(id)
      if (shadowElement) {
        return shadowElement
      }
    }
  }
  // Use the element ownerDocument here, because tests are executed in an iframe, so
  // document.getElementById won't work.
  return refElement.ownerDocument
    ? refElement.ownerDocument.getElementById(id)
    : null
}

function getTextualContent(element, configuration, nodePrivacyLevelCache) {
  if (element.isContentEditable) {
    return
  }

  if (configuration.enablePrivacyForActionName) {
    var privacyLevel = getNodePrivacyLevel(
      element,
      configuration.defaultPrivacyLevel,
      nodePrivacyLevelCache
    )
    if (shouldMaskNode(configuration, element, privacyLevel)) {
      return
    }
    return getPrivacyAwareTextualContent(
      element,
      configuration,
      nodePrivacyLevelCache
    )
  }

  return getLegacyTextualContent(element, configuration.actionNameAttribute)
}

function getLegacyTextualContent(element, userProgrammaticAttribute) {
  if ('innerText' in element) {
    var text = element.innerText

    var removeTextFromElements = function (query) {
      var list = element.querySelectorAll(query)
      for (var index = 0; index < list.length; index += 1) {
        var _element = list[index]
        if ('innerText' in _element) {
          var textToReplace = _element.innerText
          if (textToReplace && textToReplace.trim().length > 0) {
            text = text.replace(textToReplace, '')
          }
        }
      }
    }

    if (!supportsInnerTextScriptAndStyleRemoval()) {
      // remove the inner text of SCRIPT and STYLES from the result. This is a bit dirty, but should
      // be relatively fast and work in most cases.
      removeTextFromElements('script, style')
    }

    // remove the text of elements with programmatic attribute value
    removeTextFromElements(
      '[' + DEFAULT_PROGRAMMATIC_ACTION_NAME_ATTRIBUTE + ']'
    )

    if (userProgrammaticAttribute) {
      removeTextFromElements('[' + userProgrammaticAttribute + ']')
    }

    return text
  }

  return element.textContent
}

function getPrivacyAwareTextualContent(
  element,
  configuration,
  nodePrivacyLevelCache
) {
  var ownerDocument = element.ownerDocument || document
  var ownerWindow = ownerDocument.defaultView || window
  var nodeFilter = ownerWindow.NodeFilter || NodeFilter
  var walker = ownerDocument.createTreeWalker(
    element,
    nodeFilter.SHOW_ELEMENT | nodeFilter.SHOW_TEXT,
    function (node) {
      var privacyLevel = getNodePrivacyLevel(
        node,
        configuration.defaultPrivacyLevel,
        nodePrivacyLevelCache
      )
      if (shouldMaskNode(configuration, node, privacyLevel)) {
        return nodeFilter.FILTER_REJECT
      }
      if (node.nodeType === node.ELEMENT_NODE) {
        if (
          node.hasAttribute(DEFAULT_PROGRAMMATIC_ACTION_NAME_ATTRIBUTE) ||
          (configuration.actionNameAttribute &&
            node.hasAttribute(configuration.actionNameAttribute))
        ) {
          return nodeFilter.FILTER_REJECT
        }
        var style = ownerWindow.getComputedStyle(node)
        if (
          style.visibility !== 'visible' ||
          style.display === 'none' ||
          (style.contentVisibility && style.contentVisibility !== 'visible')
        ) {
          return nodeFilter.FILTER_REJECT
        }
      }
      return nodeFilter.FILTER_ACCEPT
    }
  )
  var text = ''
  while (walker.nextNode()) {
    var node = walker.currentNode
    if (node.nodeType === node.ELEMENT_NODE) {
      var style = ownerWindow.getComputedStyle(node)
      if (
        node.nodeName === 'BR' ||
        node.nodeName === 'P' ||
        ['block', 'flex', 'grid', 'list-item', 'table', 'table-caption'].indexOf(
          style.display
        ) !== -1
      ) {
        text += ' '
      }
    } else {
      text += node.textContent || ''
    }
  }
  return normalizeWhitespace(text).trim()
}

/**
 * Returns true if element.innerText excludes the text from inline SCRIPT and STYLE element. This
 * should be the case everywhere except on Internet Explorer 10 and 11 (see [1])
 *
 * The innerText property relies on what is actually rendered to compute its output, so to check if
 * it actually excludes SCRIPT and STYLE content, a solution would be to create a style element, set
 * its content to '*', inject it in the document body, and check if the style element innerText
 * property returns '*'. Using a new `document` instance won't work as it is not rendered.
 *
 * This solution requires specific CSP rules (see [2]) to be set by the customer. We want to avoid
 * this, so instead we rely on browser detection. In case of false negative, the impact should be
 * low, since we rely on this result to remove the SCRIPT and STYLE innerText (which will be empty)
 * from a parent element innerText.
 *
 * [1]: https://web.archive.org/web/20210602165716/http://perfectionkills.com/the-poor-misunderstood-innerText/#diff-with-textContent
 */
function supportsInnerTextScriptAndStyleRemoval() {
  return !isIE()
}

/**
 * Returns true if the browser supports the element.labels property.  This should be the case
 * everywhere except on Internet Explorer.
 * Note: The result is computed lazily, because we don't want any DOM access when the SDK is
 * evaluated.
 */
var supportsLabelPropertyResult
function supportsLabelProperty() {
  if (supportsLabelPropertyResult === undefined) {
    supportsLabelPropertyResult = 'labels' in HTMLInputElement.prototype
  }
  return supportsLabelPropertyResult
}
