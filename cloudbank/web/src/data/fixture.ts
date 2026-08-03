// Persona fixtures. One file per persona, all in the same shape so every
// screen and every get_* ClientFunction works for any of them without
// branching. `fixtureConformance.test.ts` enforces that shape.
//
// Vite imports the JSON at build time.

import chloeFixture from '../fixtures/chloe.json'
import davidFixture from '../fixtures/david.json'
import tomFixture from '../fixtures/tom.json'
import sarahFixture from '../fixtures/sarah.json'

import { ALL_PERSONAS, type Persona } from '../personas/personas'

export interface Transaction {
  id: string
  days_ago: number
  vendor: string
  category: string
  amount: number
  is_subscription?: boolean
  is_anomaly?: boolean
  renewal_days_ago?: number
}

export interface CurrentAccount {
  name: string
  balance: number
  currency: string
}

// Not every persona has a mortgage — Tom rents. Pages must handle its absence
// rather than assume it.
export interface Mortgage {
  balance: number
  address: string
  interest_rate: number
  rate_type: string
  term_remaining: string
  next_payment: {
    amount: number
    // A recurring day, not a date: an absolute date goes stale (the fixture
    // once announced a payment a month in the past). Resolve it with
    // nextMonthlyOccurrence().
    day_of_month: number
  }
}

export interface Fixture {
  user: {
    first_name: string
    last_name: string
    age: number
    location: string
    employment: string
    // Declared here, not just present in the JSON, so ProfilePage, HomePage
    // and MortgagePage can read them without `as never as {…}` casts.
    email?: string
    goals: string[]
  }
  accounts: {
    current: CurrentAccount
    mortgage?: Mortgage
  }
  transactions: Transaction[]
}

// Every persona in ALL_PERSONAS must have an entry — asserted by
// fixtureConformance.test.ts, so adding a persona without a fixture fails the
// suite rather than rendering an empty screen at runtime.
const FIXTURES: Record<Persona, Fixture> = {
  chloe: chloeFixture as Fixture,
  david: davidFixture as Fixture,
  tom: tomFixture as Fixture,
  sarah: sarahFixture as Fixture,
}

export function getFixture(persona: Persona): Fixture {
  return FIXTURES[persona]
}

export function allFixtures(): Array<[Persona, Fixture]> {
  return ALL_PERSONAS.map((p) => [p, FIXTURES[p]])
}
