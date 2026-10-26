import { SDKMap } from '@cloudcare/browser-core'
import { elapsed, ONE_SECOND, relativeNow } from '@cloudcare/browser-core'

// Maximum duration for click actions
export const CLICK_ACTION_MAX_DURATION = 10 * ONE_SECOND
export const interactionSelectorCache = new SDKMap()

export function getInteractionSelector(relativeTimestamp) {
  const selector = interactionSelectorCache.get(relativeTimestamp)
  interactionSelectorCache.delete(relativeTimestamp)
  return selector
}

export function updateInteractionSelector(relativeTimestamp, selector) {
  var now = relativeNow()
  interactionSelectorCache.set(relativeTimestamp, selector)
  interactionSelectorCache.forEach(function (_, relativeTimestamp) {
    if (elapsed(relativeTimestamp, now) > CLICK_ACTION_MAX_DURATION) {
      interactionSelectorCache.delete(relativeTimestamp)
    }
  })
}
