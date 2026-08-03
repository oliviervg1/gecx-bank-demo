import '@testing-library/jest-dom/vitest'

// happy-dom does not ship a WebSocket implementation. The AgentProvider opens
// a WS in its mount effect, so tests that render it would otherwise crash with
// `WebSocket is not a constructor`. A no-op stub is enough — we don't exercise
// any network behaviour in the JS-DOM tier.
class WebSocketStub {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = WebSocketStub.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  constructor(_url: string) {}
  send(_data: string | ArrayBuffer): void {}
  close(): void {
    this.readyState = WebSocketStub.CLOSED
    this.onclose?.()
  }
}
;(globalThis as unknown as { WebSocket: typeof WebSocketStub }).WebSocket = WebSocketStub

// happy-dom also does not ship the Web Audio API. AgentProvider eagerly
// constructs an AudioPlayer (which `new AudioContext(...)`s) on mount, so
// rendering it under test would crash without a stub.
class AudioContextStub {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = {}
  constructor(_options?: unknown) {}
  createBuffer(_channels: number, length: number, _rate: number) {
    return { length, duration: length / 24000, copyToChannel(): void {} }
  }
  createBufferSource() {
    return {
      buffer: null,
      onended: null as null | (() => void),
      connect(): void {},
      start(): void {},
      stop(): void {},
    }
  }
  resume(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve() }
}
;(globalThis as unknown as { AudioContext: typeof AudioContextStub }).AudioContext = AudioContextStub
