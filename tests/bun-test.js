// Minimal `bun:test` compatibility layer for running the ported pi-vcc suite
// under Node's built-in test runner. Only the API surface the vendored tests
// use is implemented; matchers follow Jest semantics closely enough for a
// verbatim port.
import { after as _after, afterEach as _afterEach, before as _before, beforeEach as _beforeEach, describe as _describe, it as _it, test as _test } from 'node:test'

export const describe = _describe
export const it = _it
export const test = _test
export const beforeAll = _before
export const afterAll = _after
export const beforeEach = _beforeEach
export const afterEach = _afterEach

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Map) && !(v instanceof Set)

/** Jest-style structural equality: undefined-valued keys are ignored. */
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false
    return true
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined)
    const ak = keys(a)
    const bk = keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

/** Subset match for toMatchObject: every expected key/value is present and deep-equal. */
function subsetEqual(expected, actual) {
  if (expected === actual) return true
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false
    return expected.every((v, i) => subsetEqual(v, actual[i]))
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    return Object.keys(expected).every((k) => subsetEqual(expected[k], actual[k]))
  }
  return deepEqual(expected, actual)
}

const fmt = (v) => {
  try {
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 2)
    return s !== undefined && s.length > 400 ? s.slice(0, 400) + '…' : s
  } catch {
    return String(v)
  }
}

class Assertion {
  constructor(actual, negate = false) {
    this.actual = actual
    this.negate = negate
  }

  get not() {
    return new Assertion(this.actual, !this.negate)
  }

  #check(pass, message) {
    const ok = this.negate ? !pass : pass
    if (!ok) throw new Error((this.negate ? 'not: ' : '') + message)
  }

  toBe(expected) {
    this.#check(Object.is(this.actual, expected) || this.actual === expected, `expected ${fmt(this.actual)} to be ${fmt(expected)}`)
  }

  toEqual(expected) {
    this.#check(deepEqual(this.actual, expected), `expected ${fmt(this.actual)} to equal ${fmt(expected)}`)
  }

  toStrictEqual(expected) {
    this.#check(deepEqual(this.actual, expected), `expected ${fmt(this.actual)} to strictly equal ${fmt(expected)}`)
  }

  toMatchObject(expected) {
    this.#check(subsetEqual(expected, this.actual), `expected ${fmt(this.actual)} to match object ${fmt(expected)}`)
  }

  toContain(expected) {
    const pass = typeof this.actual === 'string'
      ? this.actual.includes(expected)
      : Array.isArray(this.actual) ? this.actual.some((v) => deepEqual(v, expected)) : false
    this.#check(pass, `expected ${fmt(this.actual)} to contain ${fmt(expected)}`)
  }

  toHaveLength(n) {
    this.#check(this.actual != null && this.actual.length === n, `expected length ${this.actual?.length} to be ${n}`)
  }

  toBeGreaterThan(n) { this.#check(this.actual > n, `expected ${fmt(this.actual)} > ${n}`) }
  toBeGreaterThanOrEqual(n) { this.#check(this.actual >= n, `expected ${fmt(this.actual)} >= ${n}`) }
  toBeLessThan(n) { this.#check(this.actual < n, `expected ${fmt(this.actual)} < ${n}`) }
  toBeLessThanOrEqual(n) { this.#check(this.actual <= n, `expected ${fmt(this.actual)} <= ${n}`) }
  toBeTruthy() { this.#check(Boolean(this.actual), `expected ${fmt(this.actual)} to be truthy`) }
  toBeFalsy() { this.#check(!this.actual, `expected ${fmt(this.actual)} to be falsy`) }
  toBeUndefined() { this.#check(this.actual === undefined, `expected ${fmt(this.actual)} to be undefined`) }
  toBeDefined() { this.#check(this.actual !== undefined, 'expected value to be defined') }
  toBeNull() { this.#check(this.actual === null, `expected ${fmt(this.actual)} to be null`) }
  toBeNaN() { this.#check(Number.isNaN(this.actual), `expected ${fmt(this.actual)} to be NaN`) }

  toMatch(pattern) {
    const pass = typeof pattern === 'string' ? this.actual.includes(pattern) : pattern.test(this.actual)
    this.#check(pass, `expected ${fmt(this.actual)} to match ${pattern}`)
  }

  toThrow(message) {
    let threw = false
    let error
    try { this.actual() } catch (e) { threw = true; error = e }
    if (this.negate) {
      this.#check(!threw, `expected function not to throw, got ${error}`)
      return
    }
    this.#check(threw, 'expected function to throw')
    if (typeof message === 'string' && error !== undefined && !String(error?.message ?? error).includes(message)) {
      throw new Error(`expected throw message ${fmt(String(error?.message ?? error))} to contain ${fmt(message)}`)
    }
  }
}

export function expect(actual) {
  return new Assertion(actual)
}

export default { describe, it, test, expect, beforeAll, afterAll, beforeEach, afterEach }