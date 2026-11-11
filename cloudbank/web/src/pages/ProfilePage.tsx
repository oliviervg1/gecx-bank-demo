import { useState } from 'react'
import { CreditCard, LogOut, PhoneCall, Shield, User } from 'lucide-react'
import { ListRow } from '../components/ListRow'
import { IconBadge } from '../components/IconBadge'
import { useToast } from '../components/ToastProvider'
import { useAgent } from '../agent/AgentProvider'
import { useAuthSessionOptional } from '../auth/AuthProvider'
import { useFixture } from '../data/useFixture'

function initialsFromName(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
}

export function ProfilePage() {
  const { show } = useToast()
  const { disconnect, reconnect } = useAgent()
  const auth = useAuthSessionOptional()
  const [fallbackLoggedOut, setFallbackLoggedOut] = useState(false)
  const [cardFrozen, setCardFrozen] = useState(false)
  const user = useFixture().user
  const initials = initialsFromName(user.first_name, user.last_name)
  const email =
    user.email ?? `${user.first_name.toLowerCase()}.${user.last_name.toLowerCase()}@example.com`

  const loggedOut = auth ? auth.signedOut : fallbackLoggedOut

  function handleSignOut() {
    if (auth) {
      auth.signOut()
      return
    }
    disconnect({ clearTurns: true })
    setFallbackLoggedOut(true)
  }

  function handleSignBackIn() {
    if (auth) {
      auth.signBackIn()
      return
    }
    reconnect()
    setFallbackLoggedOut(false)
  }

  if (loggedOut) {
    return (
      <div className="pt-12 flex flex-col items-center gap-4 text-center">
        <div className="p-6 rounded-xl border border-brand-divider bg-white w-full">
          <h1 className="text-[1.125rem] font-semibold text-brand-text mb-2">
            You&apos;ve been signed out
          </h1>
          <p className="text-[0.8125rem] text-brand-muted mb-4">
            Your active concierge session has been closed.
          </p>
          <button
            type="button"
            onClick={handleSignBackIn}
            className="min-h-10 px-4 py-2 rounded-lg bg-brand-green text-white text-[0.875rem] font-semibold"
          >
            Sign back in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pb-6">
      <div className="pt-4 pb-4 border-b border-brand-divider flex items-center gap-3.5">
        <div className="w-12 h-12 rounded-full bg-brand-green text-white flex items-center justify-center font-bold text-[1.125rem] shrink-0">
          {initials}
        </div>
        <div className="min-w-0">
          <h1 className="text-[1.25rem] font-bold tracking-[-0.01em] text-brand-text leading-tight truncate">
            {user.first_name} {user.last_name}
          </h1>
          <div className="text-[0.8125rem] text-brand-muted truncate">{email}</div>
        </div>
      </div>

      {/* Personal & Card Controls */}
      <div className="divide-y divide-brand-divider border-b border-brand-divider">
        <ListRow
          icon={<IconBadge icon={User} tone="green" />}
          title="Personal Details"
          subtitle={`${user.employment} · ${user.location} · Age ${user.age}`}
        />

        <ListRow
          icon={<IconBadge icon={CreditCard} tone={cardFrozen ? 'gold' : 'green'} />}
          title="Debit Card Controls"
          subtitle={
            cardFrozen
              ? 'Card temporarily frozen · Recurring direct debits unaffected'
              : 'Card active · Instant freeze available for unrecognised charges'
          }
          right={
            <button
              type="button"
              onClick={() => {
                const next = !cardFrozen
                setCardFrozen(next)
                show(next ? 'Your debit card is frozen.' : 'Your debit card is unfrozen.')
              }}
              className={
                'min-h-9 px-3 py-1.5 rounded-lg text-[0.75rem] font-semibold border transition-colors ' +
                (cardFrozen
                  ? 'border-brand-gold-text text-brand-gold-text bg-[#fcf9f2]'
                  : 'border-brand-border-strong text-brand-text bg-white hover:bg-[#faf9f6]')
              }
            >
              {cardFrozen ? 'Unfreeze' : 'Freeze card'}
            </button>
          }
        />

        <ListRow
          icon={<IconBadge icon={Shield} tone="green" />}
          title="Privacy & Security"
          subtitle="Two-step verification on · Biometric sign-in active"
        />

        <ListRow
          icon={<IconBadge icon={PhoneCall} tone="muted" />}
          title="Specialist Support"
          subtitle="Freephone 0808 157 0100 · Samaritans 116 123"
        />
      </div>

      <button
        type="button"
        onClick={handleSignOut}
        className="mt-5 min-h-10 w-full py-2.5 rounded-lg border border-brand-danger text-brand-danger text-[0.875rem] font-semibold flex items-center justify-center gap-2 bg-white hover:bg-[#fdf6f6] transition-colors"
      >
        <LogOut size={16} aria-hidden="true" />
        Log out securely
      </button>

      <div className="text-center text-[0.6875rem] text-brand-muted mt-3">
        Cloudbank Personal Banking
      </div>
    </div>
  )
}
