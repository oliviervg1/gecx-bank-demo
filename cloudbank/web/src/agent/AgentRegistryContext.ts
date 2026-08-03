import { createContext, useContext } from 'react'
import { createRegistry, type Registry } from './clientFunctions'

// Standalone context so handlers can be unit-tested without spinning up
// the entire AgentProvider (which owns the WS, audio worklet, etc.).
// AgentProvider wraps its children with this context populated from its
// internal registryRef.
export const AgentRegistryContext = createContext<Registry>(createRegistry())

export function useAgentRegistry(): Registry {
  return useContext(AgentRegistryContext)
}
