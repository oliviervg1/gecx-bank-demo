// Persona fixtures (`customer_snapshot` verbatim).
//
// All monetary amounts are stored in integer pence (`*_pence`) and all rates
// in integer basis points (`*_bps`) so TypeScript selectors and CXAS Python
// controllers execute identical integer arithmetic with zero floating-point
// rounding drift. Every fixture is validated against
// `cloudbank/shared/customer_snapshot.schema.json` in both Vitest and Pytest.

import chloeFixture from '../fixtures/chloe.json'
import davidFixture from '../fixtures/david.json'
import tomFixture from '../fixtures/tom.json'
import sarahFixture from '../fixtures/sarah.json'

import { ALL_PERSONAS, type Persona } from '../personas/personas'

export const SPEND_CATEGORIES = [
  'groceries',
  'coffee_shops',
  'eating_out',
  'subscriptions',
  'transport',
  'shopping',
  'bills',
  'entertainment',
] as const

export type SpendCategory = (typeof SPEND_CATEGORIES)[number]
export type TransactionCategory = SpendCategory | 'income'

export type MonthOffset = 0 | 1 | 2

export interface Transaction {
  id: string
  month_offset: MonthOffset
  day: number
  vendor: string
  category: TransactionCategory
  amount_pence: number
  is_subscription?: boolean
  is_anomaly?: boolean
}

export interface CurrentAccount {
  name: string
  sort_code: string
  account_number_last4: string
  balance_pence: number
  currency: 'GBP'
}

export interface SavingsAccount {
  name: string
  balance_pence: number
  // Nominal annual rate in basis points used for monthly compounding math.
  gross_rate_bps: number
  // Effective annual rate (AER) in basis points for display and speech.
  aer_bps: number
  monthly_contribution_pence: number
  goal_name: string
  goal_target_pence: number
}

export interface MortgageRenewalOption {
  id: string
  label: string
  term_years: number
  rate_bps: number
}

// Not every persona has a mortgage — Tom rents. Pages and controllers handle
// its absence gracefully.
export interface Mortgage {
  balance_pence: number
  address: string
  interest_rate_bps: number
  rate_type: string
  fixed_until: string
  term_remaining_months: number
  next_payment: {
    amount_pence: number
    day_of_month: number
  }
  annual_overpayment_allowance_pence: number
  overpaid_this_year_pence: number
  renewal_options: MortgageRenewalOption[]
}

export interface UserProfile {
  first_name: string
  last_name: string
  age: number
  location: string
  employment: string
  email?: string
  annual_income_pence: number
  monthly_rent_pence?: number
  goals: string[]
}

export interface Fixture {
  user: UserProfile
  accounts: {
    current: CurrentAccount
    savings: SavingsAccount
    mortgage?: Mortgage
  }
  transactions: Transaction[]
}

export type CustomerSnapshot = Fixture

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
