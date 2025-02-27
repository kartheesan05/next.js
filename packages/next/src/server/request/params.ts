import type { WorkStore } from '../app-render/work-async-storage.external'
import type { FallbackRouteParams } from './fallback-params'

import { ReflectAdapter } from '../web/spec-extension/adapters/reflect'
import {
  abortAndThrowOnSynchronousRequestDataAccess,
  throwToInterruptStaticGeneration,
  postponeWithTracking,
} from '../app-render/dynamic-rendering'

import {
  workUnitAsyncStorage,
  type PrerenderStorePPR,
  type PrerenderStoreLegacy,
  type PrerenderStoreModern,
} from '../app-render/work-unit-async-storage.external'
import { InvariantError } from '../../shared/lib/invariant-error'
import {
  makeResolvedReactPromise,
  describeStringPropertyAccess,
  wellKnownProperties,
} from './utils'
import { makeHangingPromise } from '../dynamic-rendering-utils'
import { createDedupedByCallsiteServerErrorLoggerDev } from '../create-deduped-by-callsite-server-error-loger'

export type Params = Record<string, string | Array<string> | undefined>

/**
 * In this version of Next.js the `params` prop passed to Layouts, Pages, and other Segments is a Promise.
 * However to facilitate migration to this new Promise type you can currently still access params directly on the Promise instance passed to these Segments.
 * The `UnsafeUnwrappedParams` type is available if you need to temporarily access the underlying params without first awaiting or `use`ing the Promise.
 *
 * In a future version of Next.js the `params` prop will be a plain Promise and this type will be removed.
 *
 * Typically instances of `params` can be updated automatically to be treated as a Promise by a codemod published alongside this Next.js version however if you
 * have not yet run the codemod of the codemod cannot detect certain instances of `params` usage you should first try to refactor your code to await `params`.
 *
 * If refactoring is not possible but you still want to be able to access params directly without typescript errors you can cast the params Promise to this type
 *
 * ```tsx
 * type Props = { params: Promise<{ id: string }>}
 *
 * export default async function Layout(props: Props) {
 *  const directParams = (props.params as unknown as UnsafeUnwrappedParams<typeof props.params>)
 *  return ...
 * }
 * ```
 *
 * This type is marked deprecated to help identify it as target for refactoring away.
 *
 * @deprecated
 */
export type UnsafeUnwrappedParams<P> =
  P extends Promise<infer U> ? Omit<U, 'then' | 'status' | 'value'> : never

export function createPrerenderParamsFromClient(
  underlyingParams: Params,
  workStore: WorkStore
) {
  return createPrerenderParams(underlyingParams, workStore)
}

export function createRenderParamsFromClient(
  underlyingParams: Params,
  workStore: WorkStore
) {
  return createRenderParams(underlyingParams, workStore)
}

// generateMetadata always runs in RSC context so it is equivalent to a Server Page Component
export type CreateServerParamsForMetadata = typeof createServerParamsForMetadata
export const createServerParamsForMetadata = createServerParamsForServerSegment

// routes always runs in RSC context so it is equivalent to a Server Page Component
export function createServerParamsForRoute(
  underlyingParams: Params,
  workStore: WorkStore
) {
  if (workStore.isStaticGeneration) {
    return createPrerenderParams(underlyingParams, workStore)
  } else {
    return createRenderParams(underlyingParams, workStore)
  }
}

export function createServerParamsForServerSegment(
  underlyingParams: Params,
  workStore: WorkStore
): Promise<Params> {
  if (workStore.isStaticGeneration) {
    return createPrerenderParams(underlyingParams, workStore)
  } else {
    return createRenderParams(underlyingParams, workStore)
  }
}

export function createPrerenderParamsForClientSegment(
  underlyingParams: Params,
  workStore: WorkStore
): Promise<Params> {
  const prerenderStore = workUnitAsyncStorage.getStore()
  if (prerenderStore && prerenderStore.type === 'prerender') {
    const fallbackParams = workStore.fallbackRouteParams
    if (fallbackParams) {
      for (let key in underlyingParams) {
        if (fallbackParams.has(key)) {
          // This params object has one of more fallback params so we need to consider
          // the awaiting of this params object "dynamic". Since we are in dynamicIO mode
          // we encode this as a promise that never resolves
          return makeHangingPromise(prerenderStore.renderSignal, '`params`')
        }
      }
    }
  }
  // We're prerendering in a mode that does not abort. We resolve the promise without
  // any tracking because we're just transporting a value from server to client where the tracking
  // will be applied.
  return makeResolvedReactPromise(underlyingParams)
}

function createPrerenderParams(
  underlyingParams: Params,
  workStore: WorkStore
): Promise<Params> {
  const fallbackParams = workStore.fallbackRouteParams
  if (fallbackParams) {
    let hasSomeFallbackParams = false
    for (const key in underlyingParams) {
      if (fallbackParams.has(key)) {
        hasSomeFallbackParams = true
        break
      }
    }

    if (hasSomeFallbackParams) {
      // params need to be treated as dynamic because we have at least one fallback param
      const workUnitStore = workUnitAsyncStorage.getStore()
      if (workUnitStore) {
        if (workUnitStore.type === 'prerender') {
          // We are in a dynamicIO (PPR or otherwise) prerender
          return makeAbortingExoticParams(
            underlyingParams,
            workStore.route,
            workUnitStore
          )
        } else if (
          workUnitStore.type === 'prerender-legacy' ||
          workUnitStore.type === 'prerender-ppr'
        )
          // We aren't in a dynamicIO prerender but we do have fallback params at this
          // level so we need to make an erroring exotic params object which will postpone
          // if you access the fallback params
          return makeErroringExoticParams(
            underlyingParams,
            fallbackParams,
            workStore,
            workUnitStore
          )
      }
      throw new InvariantError(
        'createPrerenderParams called without a prerenderStore in scope. This is a bug in Next.js'
      )
    }
  }

  // We don't have any fallback params so we have an entirely static safe params object
  return makeUntrackedExoticParams(underlyingParams)
}

function createRenderParams(
  underlyingParams: Params,
  workStore: WorkStore
): Promise<Params> {
  if (process.env.NODE_ENV === 'development' && !workStore.isPrefetchRequest) {
    return makeDynamicallyTrackedExoticParamsWithDevWarnings(
      underlyingParams,
      workStore
    )
  } else {
    return makeUntrackedExoticParams(underlyingParams)
  }
}

interface CacheLifetime {}
const CachedParams = new WeakMap<CacheLifetime, Promise<Params>>()

function makeAbortingExoticParams(
  underlyingParams: Params,
  route: string,
  prerenderStore: PrerenderStoreModern
): Promise<Params> {
  const cachedParams = CachedParams.get(underlyingParams)
  if (cachedParams) {
    return cachedParams
  }

  const promise = makeHangingPromise<Params>(
    prerenderStore.renderSignal,
    '`params`'
  )
  CachedParams.set(underlyingParams, promise)

  Object.keys(underlyingParams).forEach((prop) => {
    if (wellKnownProperties.has(prop)) {
      // These properties cannot be shadowed because they need to be the
      // true underlying value for Promises to work correctly at runtime
    } else {
      Object.defineProperty(promise, prop, {
        get() {
          const expression = describeStringPropertyAccess('params', prop)
          const error = new Error(
            `Route "${route}" used ${expression}. \`params\` is now a Promise and should be \`awaited\` before accessing param values. See more info here: https://nextjs.org/docs/messages/next-prerender-sync-params`
          )
          abortAndThrowOnSynchronousRequestDataAccess(
            route,
            expression,
            error,
            prerenderStore
          )
        },
        set(newValue) {
          Object.defineProperty(promise, prop, {
            value: newValue,
            writable: true,
            enumerable: true,
          })
        },
        enumerable: true,
        configurable: true,
      })
    }
  })

  return promise
}

function makeErroringExoticParams(
  underlyingParams: Params,
  fallbackParams: FallbackRouteParams,
  workStore: WorkStore,
  prerenderStore: PrerenderStorePPR | PrerenderStoreLegacy
): Promise<Params> {
  const cachedParams = CachedParams.get(underlyingParams)
  if (cachedParams) {
    return cachedParams
  }

  const augmentedUnderlying = { ...underlyingParams }

  // We don't use makeResolvedReactPromise here because params
  // supports copying with spread and we don't want to unnecessarily
  // instrument the promise with spreadable properties of ReactPromise.
  const promise = Promise.resolve(augmentedUnderlying)
  CachedParams.set(underlyingParams, promise)

  Object.keys(underlyingParams).forEach((prop) => {
    if (wellKnownProperties.has(prop)) {
      // These properties cannot be shadowed because they need to be the
      // true underlying value for Promises to work correctly at runtime
    } else {
      if (fallbackParams.has(prop)) {
        Object.defineProperty(augmentedUnderlying, prop, {
          get() {
            const expression = describeStringPropertyAccess('params', prop)
            // In most dynamic APIs we also throw if `dynamic = "error"` however
            // for params is only dynamic when we're generating a fallback shell
            // and even when `dynamic = "error"` we still support generating dynamic
            // fallback shells
            // TODO remove this comment when dynamicIO is the default since there
            // will be no `dynamic = "error"`
            if (prerenderStore.type === 'prerender-ppr') {
              // PPR Prerender (no dynamicIO)
              postponeWithTracking(
                workStore.route,
                expression,
                prerenderStore.dynamicTracking
              )
            } else {
              // Legacy Prerender
              throwToInterruptStaticGeneration(
                expression,
                workStore,
                prerenderStore
              )
            }
          },
          enumerable: true,
        })
        Object.defineProperty(promise, prop, {
          get() {
            const expression = describeStringPropertyAccess('params', prop)
            // In most dynamic APIs we also throw if `dynamic = "error"` however
            // for params is only dynamic when we're generating a fallback shell
            // and even when `dynamic = "error"` we still support generating dynamic
            // fallback shells
            // TODO remove this comment when dynamicIO is the default since there
            // will be no `dynamic = "error"`
            if (prerenderStore.type === 'prerender-ppr') {
              // PPR Prerender (no dynamicIO)
              postponeWithTracking(
                workStore.route,
                expression,
                prerenderStore.dynamicTracking
              )
            } else {
              // Legacy Prerender
              throwToInterruptStaticGeneration(
                expression,
                workStore,
                prerenderStore
              )
            }
          },
          set(newValue) {
            Object.defineProperty(promise, prop, {
              value: newValue,
              writable: true,
              enumerable: true,
            })
          },
          enumerable: true,
          configurable: true,
        })
      } else {
        ;(promise as any)[prop] = underlyingParams[prop]
      }
    }
  })

  return promise
}

function makeUntrackedExoticParams(underlyingParams: Params): Promise<Params> {
  const cachedParams = CachedParams.get(underlyingParams)
  if (cachedParams) {
    return cachedParams
  }

  // We don't use makeResolvedReactPromise here because params
  // supports copying with spread and we don't want to unnecessarily
  // instrument the promise with spreadable properties of ReactPromise.
  const promise = Promise.resolve(underlyingParams)
  CachedParams.set(underlyingParams, promise)

  Object.keys(underlyingParams).forEach((prop) => {
    if (wellKnownProperties.has(prop)) {
      // These properties cannot be shadowed because they need to be the
      // true underlying value for Promises to work correctly at runtime
    } else {
      ;(promise as any)[prop] = underlyingParams[prop]
    }
  })

  return promise
}

function makeDynamicallyTrackedExoticParamsWithDevWarnings(
  underlyingParams: Params,
  store: WorkStore
): Promise<Params> {
  const cachedParams = CachedParams.get(underlyingParams)
  if (cachedParams) {
    return cachedParams
  }

  // We don't use makeResolvedReactPromise here because params
  // supports copying with spread and we don't want to unnecessarily
  // instrument the promise with spreadable properties of ReactPromise.
  const promise = Promise.resolve(underlyingParams)

  const proxiedProperties = new Set<string>()
  const unproxiedProperties: Array<string> = []

  Object.keys(underlyingParams).forEach((prop) => {
    if (wellKnownProperties.has(prop)) {
      // These properties cannot be shadowed because they need to be the
      // true underlying value for Promises to work correctly at runtime
      unproxiedProperties.push(prop)
    } else {
      proxiedProperties.add(prop)
      ;(promise as any)[prop] = underlyingParams[prop]
    }
  })

  const proxiedPromise = new Proxy(promise, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        if (
          // We are accessing a property that was proxied to the promise instance
          proxiedProperties.has(prop)
        ) {
          const expression = describeStringPropertyAccess('params', prop)
          warnForSyncAccess(store.route, expression)
        }
      }
      return ReflectAdapter.get(target, prop, receiver)
    },
    set(target, prop, value, receiver) {
      if (typeof prop === 'string') {
        proxiedProperties.delete(prop)
      }
      return ReflectAdapter.set(target, prop, value, receiver)
    },
    ownKeys(target) {
      warnForEnumeration(store.route, unproxiedProperties)
      return Reflect.ownKeys(target)
    },
  })

  CachedParams.set(underlyingParams, proxiedPromise)
  return proxiedPromise
}

const noop = () => {}

const warnForSyncAccess = process.env.__NEXT_DISABLE_SYNC_DYNAMIC_API_WARNINGS
  ? noop
  : createDedupedByCallsiteServerErrorLoggerDev(function getSyncAccessMessage(
      route: undefined | string,
      expression: string
    ) {
      const prefix = route ? ` In route ${route} a ` : 'A '
      return new Error(
        `${prefix}param property was accessed directly with ${expression}. ` +
          `\`params\` should be awaited before accessing its properties. ` +
          `Learn more: https://nextjs.org/docs/messages/sync-dynamic-apis`
      )
    })

const warnForEnumeration = process.env.__NEXT_DISABLE_SYNC_DYNAMIC_API_WARNINGS
  ? noop
  : createDedupedByCallsiteServerErrorLoggerDev(function getEnumerationMessage(
      route: undefined | string,
      missingProperties: Array<string>
    ) {
      const prefix = route ? ` In route ${route} ` : ''
      if (missingProperties.length) {
        const describedMissingProperties =
          describeListOfPropertyNames(missingProperties)
        return new Error(
          `${prefix}params are being enumerated incompletely missing these properties: ${describedMissingProperties}. ` +
            `\`params\` should be awaited before accessing its properties. ` +
            `Learn more: https://nextjs.org/docs/messages/sync-dynamic-apis`
        )
      } else {
        return new Error(
          `${prefix}params are being enumerated. ` +
            `\`params\` should be awaited before accessing its properties. ` +
            `Learn more: https://nextjs.org/docs/messages/sync-dynamic-apis`
        )
      }
    })

function describeListOfPropertyNames(properties: Array<string>) {
  switch (properties.length) {
    case 0:
      throw new InvariantError(
        'Expected describeListOfPropertyNames to be called with a non-empty list of strings.'
      )
    case 1:
      return `\`${properties[0]}\``
    case 2:
      return `\`${properties[0]}\` and \`${properties[1]}\``
    default: {
      let description = ''
      for (let i = 0; i < properties.length - 1; i++) {
        description += `\`${properties[i]}\`, `
      }
      description += `, and \`${properties[properties.length - 1]}\``
      return description
    }
  }
}
