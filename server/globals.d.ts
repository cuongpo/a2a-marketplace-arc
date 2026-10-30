// Minimal typings for the Bun APIs this backend uses. Full @types/bun is intentionally not loaded:
// it redefines global fetch and conflicts with the browser tracing shim in src/tracing.ts.
interface ImportMeta {
  main: boolean
}

declare const Bun: {
  stdin: { stream(): ReadableStream }
  serve(options: { port: number; hostname?: string; fetch(req: Request): Response | Promise<Response> }): unknown
}

declare module 'bun:test' {
  type Fn = () => void | Promise<void>
  export function describe(name: string, fn: () => void): void
  export function test(name: string, fn: Fn): void
  export function beforeAll(fn: Fn): void
  export function beforeEach(fn: Fn): void
  export function afterAll(fn: Fn): void
  export function expect(value: unknown): {
    not: ReturnType<typeof expect>
    rejects: { toThrow(v?: unknown): Promise<void> }
    toBe(v: unknown): void
    toEqual(v: unknown): void
    toBeDefined(): void
    toBeNull(): void
    toBeUndefined(): void
    toContain(v: unknown): void
    toThrow(v?: unknown): void
    toBeGreaterThan(v: number): void
    toBeLessThanOrEqual(v: number): void
  }
}
