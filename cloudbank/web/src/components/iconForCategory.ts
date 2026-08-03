import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  ShoppingCart, Coffee, Utensils, Train, Zap, Tv, ShoppingBag, Ticket,
  Briefcase, HelpCircle,
} from 'lucide-react'
import type { IconTone } from './IconBadge'

export type SpendingCategory =
  | 'groceries' | 'coffee_shops' | 'eating_out' | 'transport'
  | 'bills' | 'subscriptions' | 'shopping' | 'entertainment' | 'income'

interface CategoryStyle {
  icon: ComponentType<LucideProps>
  tone: IconTone
}

const MAP: Record<SpendingCategory, CategoryStyle> = {
  groceries:     { icon: ShoppingCart, tone: 'green' },
  coffee_shops:  { icon: Coffee,       tone: 'gold'  },
  eating_out:    { icon: Utensils,     tone: 'gold'  },
  transport:     { icon: Train,        tone: 'green' },
  bills:         { icon: Zap,          tone: 'green' },
  subscriptions: { icon: Tv,           tone: 'green' },
  shopping:      { icon: ShoppingBag,  tone: 'green' },
  entertainment: { icon: Ticket,       tone: 'gold'  },
  income:        { icon: Briefcase,    tone: 'gold'  },
}

const FALLBACK: CategoryStyle = { icon: HelpCircle, tone: 'muted' }

export function iconForCategory(cat: SpendingCategory): CategoryStyle {
  return MAP[cat] ?? FALLBACK
}
