import { keccak256, toBytes, type Hex } from 'viem'

/**
 * Canonical JSON: object keys sorted lexicographically (recursively), no whitespace,
 * integers and strings only for numeric money/identity fields. Floats are rejected so the
 * same bundle always hashes to the same bytes on every machine.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error('canonicalize: only safe integers allowed, got ' + String(value))
      return String(value)
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
    }
    default:
      throw new Error('canonicalize: unsupported type ' + typeof value)
  }
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(toBytes(canonicalize(value)))
}

export function hashText(text: string): Hex {
  return keccak256(toBytes(text))
}

/**
 * Canonical JSON for API request authentication. Same key ordering rules as `canonicalize`, but any finite
 * JSON number is allowed (field-operator payloads may contain decimals). Both the browser/script signer and the
 * server compute it over the parsed body, so key order and whitespace never change the hash.
 */
export function canonicalizeLoose(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalizeLoose: non-finite number')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalizeLoose).join(',') + ']'
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizeLoose(obj[k])).join(',') + '}'
    }
    default:
      throw new Error('canonicalizeLoose: unsupported type ' + typeof value)
  }
}

export function hashRequestBody(body: unknown): Hex {
  return keccak256(toBytes(canonicalizeLoose(body ?? {})))
}
