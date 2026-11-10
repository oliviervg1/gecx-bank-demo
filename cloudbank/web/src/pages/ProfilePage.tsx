import { useState } from 'react'
import { CreditCard, LogOut, PhoneCall, Shield, User } from 'lucide-react'
import { ListRow } from '../components/ListRow'
import { IconBadge } from '../components/IconBadge'
import { useToast } from '../components/ToastProvider'
import { useAgent } from '../agent/AgentProvider'
import { useFixture } from '../data/useFixture'

function initialsFromName(first: string, last: string): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase()
}

export function ProfilePage() {
  const { show } = useToast()
  const { disconnect, reconnect } = useAgent()
  const [loggedOut, setLoggedOut] = useState(false)
  const [cardFrozen, setCardFrozen] = useState(false)
  const user = useFixture().user
  const initials = initialsFromName(user.first_name, user.last_name)
  const email =
    user.email ?? `${user.first_name.toLowerCase()}.${user.last_name.toLowerCase()}@example.com`

  if (loggedOut) {
    return (
      <div className="pt-12 flex flex-col items-center gap-4 text-center">
        <div className="p-6 rounded-xl border border-brand-divider bg-white w-full">
          <h2 className="text-[18px] font-semibold text-brand-text mb-2">
            You&apos;ve been signed out
          </h2>
          <p className="text-[13px] text-brand-muted mb-4">
            Your active concierge session has been closed.
          </p>
          <button
            type="button"
            onClick={() => {
              reconnect()
              setLoggedOut(false)
            }}
            className="px-4 py-2 rounded-lg bg-brand-green text-white text-[14px] font-semibold"
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
        <div className="w-12 h-12 rounded-full bg-brand-green text-white flex items-center justify-center font-bold text-[18px] shrink-0">
          {initials}
        </div>
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold tracking-[-0.01em] text-brand-text leading-tight truncate">
            {user.first_name} {user.last_name}
          </h1>
          <div className="text-[13px] text-brand-muted truncate">{email}</div>
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
              ? 'Card temporarily frozen — recurring direct debits unaffected'
              : 'Card active · Instant freeze available for unrecognised charges'
          }
          right={
            <button
              type="button"
              onClick={() => {
                const next = !cardFrozen
                setCardFrozen(next)
                show(next ? 'Debit card frozen on screen.' : 'Debit card unfrozen.')
              }}
              className={
                'px-3 py-1 rounded-lg text-[12px] font-semibold border ' +
                (cardFrozen
                  ? 'border-brand-gold text-brand-gold bg-[#fcf9f2]'
                  : 'border-brand-divider text-brand-text bg-white hover:bg-[#faf9f6]')
              }
            >
              {cardFrozen ? 'Unfreeze' : 'Freeze card'}
            </button>
          }
        />

        <ListRow
          icon={<IconBadge icon={Shield} tone="green" />}
          title="Privacy & Guardrails"
          subtitle="FCA Consumer Duty & prompt security active"
        />

        <ListRow
          icon={<IconBadge icon={PhoneCall} tone="muted" />}
          title="Specialist Support"
          subtitle="Freephone 0808 157 0100 · Samaritans 116 123"
        />
      </div>

      <button
        type="button"
        onClick={() => {
          disconnect()
          setLoggedOut(true)
        }}
        className="mt-5 w-full py-2.5 rounded-lg border border-brand-danger text-brand-danger text-[14px] font-semibold flex items-center justify-center gap-2 bg-white hover:bg-[#fdf6f6] transition-colors"
      >
        <LogOut size={16} />
        Log out securely
      </button>

      <div className="text-center text-[11px] text-brand-muted mt-3">
        Cloudbank Retail Reference · GECX Composite v2
      </div>
    </div>
  )
}
