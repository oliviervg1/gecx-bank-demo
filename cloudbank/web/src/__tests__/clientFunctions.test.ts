import { describe, it, expect, beforeEach } from 'vitest'
import { createRegistry } from '../agent/clientFunctions'

describe('clientFunctions registry', () => {
  let registry: ReturnType<typeof createRegistry>
  beforeEach(() => { registry = createRegistry() })

  it('dispatches a registered handler and returns its output', async () => {
    registry.register('echo', (args) => ({ heard: (args as { msg: string }).msg }))
    const result = await registry.dispatch({ id: 'tc_1', name: 'echo', args: { msg: 'hi' } })
    expect(result).toEqual({ id: 'tc_1', response: { output: { heard: 'hi' } } })
  })

  it('returns an error envelope for an unknown handler', async () => {
    const result = await registry.dispatch({ id: 'tc_2', name: 'mystery', args: {} })
    expect(result).toEqual({ id: 'tc_2', response: { error: 'unknown_function: mystery' } })
  })

  it('catches handler exceptions and returns an error envelope', async () => {
    registry.register('boom', () => { throw new Error('oops') })
    const result = await registry.dispatch({ id: 'tc_3', name: 'boom', args: {} })
    expect(result).toEqual({ id: 'tc_3', response: { error: 'handler_error: oops' } })
  })

  // The get_* handlers signal failure by RETURNING { error: '...' } rather
  // than throwing. Without this mapping they reached CES as
  // {"output":{"error":"no_data_for_month"}} — a *successful* tool result with
  // an error key buried in the body, which the model had to notice on its own.
  it('maps a returned { error } result onto the error envelope', async () => {
    registry.register('lookup', () => ({ error: 'no_data_for_month' }))
    const result = await registry.dispatch({ id: 'tc_5', name: 'lookup', args: {} })
    expect(result).toEqual({ id: 'tc_5', response: { error: 'no_data_for_month' } })
  })

  it('does not mistake a legitimate payload containing an error field for a failure', async () => {
    registry.register('report', () => ({ error: 'none', total: 42 }))
    const result = await registry.dispatch({ id: 'tc_6', name: 'report', args: {} })
    expect(result).toEqual({ id: 'tc_6', response: { output: { error: 'none', total: 42 } } })
  })

  it('supports async handlers', async () => {
    registry.register('slow', async (args) => ({ doubled: (args as { x: number }).x * 2 }))
    const result = await registry.dispatch({ id: 'tc_4', name: 'slow', args: { x: 21 } })
    expect(result).toEqual({ id: 'tc_4', response: { output: { doubled: 42 } } })
  })
})
