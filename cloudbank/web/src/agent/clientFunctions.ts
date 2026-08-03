// Client-function registry + dispatcher.
//
// Handlers are async-or-sync functions: (args) => result | Promise<result>.
// Result must be JSON-serialisable. The dispatcher wraps success in
// { output: ... } and failure (missing handler or thrown exception) in
// { error: "<reason>" } per the CES ToolResponse contract.

export type ClientFunctionArgs = Record<string, unknown>
export type ClientFunctionResult = Record<string, unknown>
export type ClientFunctionHandler = (args: ClientFunctionArgs) => ClientFunctionResult | Promise<ClientFunctionResult>

export interface ToolCall {
  id: string
  name: string
  args: ClientFunctionArgs
}

export interface ToolResponseEnvelope {
  id: string
  response: { output: ClientFunctionResult } | { error: string }
}

export interface Registry {
  register: (name: string, handler: ClientFunctionHandler) => void
  unregister: (name: string) => void
  dispatch: (call: ToolCall) => Promise<ToolResponseEnvelope>
}

export function createRegistry(): Registry {
  const handlers = new Map<string, ClientFunctionHandler>()

  return {
    register(name, handler) { handlers.set(name, handler) },
    unregister(name) { handlers.delete(name) },
    async dispatch(call) {
      const handler = handlers.get(call.name)
      if (!handler) {
        return { id: call.id, response: { error: `unknown_function: ${call.name}` } }
      }
      try {
        const output = await handler(call.args)
        // Handlers signal failure by RETURNING { error: '...' } rather than
        // throwing. Without this branch those shipped as
        // {"output":{"error":"no_data_for_month"}} — a successful tool result
        // whose body happened to contain an `error` key, leaving the model to
        // notice it. Map them onto the real error envelope.
        if (
          output !== null &&
          typeof output === 'object' &&
          typeof (output as { error?: unknown }).error === 'string' &&
          Object.keys(output).length === 1
        ) {
          return { id: call.id, response: { error: (output as { error: string }).error } }
        }
        return { id: call.id, response: { output } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { id: call.id, response: { error: `handler_error: ${message}` } }
      }
    },
  }
}
