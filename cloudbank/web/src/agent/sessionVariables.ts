// The CES session-variable channel carries only the customer's first name.
// Everything else (spending, anomaly) moves to the agent's get_* ClientFunctions
// (see spendingHandlers.ts). first_name stays a variable so the warm opening
// greeting fires with no tool round-trip.
//
// Structural parameter rather than a concrete Fixture type: this module reads
// exactly one field, and typing it narrowly is what let the Chloe-only shape
// (`ChloeFixture`) leak into the agent layer.
export interface HasFirstName {
  user: { first_name: string }
}

export function buildSessionVariables(fixture: HasFirstName): Record<string, string> {
  return { first_name: fixture.user.first_name }
}
