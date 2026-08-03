import { useState } from 'react'
import { User, Bell, Shield, HelpCircle, LogOut, ChevronRight } from 'lucide-react'
import { Card } from '../components/Card'
import { ListRow } from '../components/ListRow'
import { IconBadge } from '../components/IconBadge'
import { useToast } from '../components/ToastProvider'
import { useAgent } from '../agent/AgentProvider'
import { useFixture } from '../data/useFixture'

const COMING_SOON = 'Coming soon.'

function initialsFromName(first: string, last: string): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase()
}

export function ProfilePage() {
  const { show } = useToast()
  const { disconnect, reconnect } = useAgent()
  const [loggedOut, setLoggedOut] = useState(false)
  const user = useFixture().user
  const initials = initialsFromName(user.first_name, user.last_name)
  const email = user.email ?? `${user.first_name.toLowerCase()}.${user.last_name.toLowerCase()}@example.com`

  if (loggedOut) {
    return (
      <div className="pt-10 flex flex-col items-center gap-4">
        <Card className="text-center">
          <h2 className="text-[18px] font-semibold mb-2">You've been logged out.</h2>
          <button
            type="button"
            onClick={() => { reconnect(); setLoggedOut(false) }}
            className="text-brand-green font-semibold"
          >
            Sign back in
          </button>
        </Card>
      </div>
    )
  }

  return (
    <div className="pb-4">
      <div className="flex items-center gap-3 mt-2 mb-5">
        <div
          className="w-16 h-16 rounded-full bg-brand-green text-white flex items-center justify-center font-bold text-[24px]"
        >
          {initials}
        </div>
        <div>
          <div className="text-[20px] font-bold leading-tight">{user.first_name} {user.last_name}</div>
          <div className="text-[14px] text-brand-muted">{email}</div>
        </div>
      </div>

      <Card className="p-0 mb-5">
        <ProfileRow icon={User}        tone="green" title="Personal Details"     onClick={() => show(COMING_SOON)} />
        <Divider />
        <ProfileRow icon={Bell}        tone="gold"  title="Notifications"        onClick={() => show(COMING_SOON)} />
        <Divider />
        <ProfileRow icon={Shield}      tone="green" title="Privacy & Security"   onClick={() => show(COMING_SOON)} />
        <Divider />
        <ProfileRow icon={HelpCircle}  tone="muted" title="Help & Support"       onClick={() => show(COMING_SOON)} />
      </Card>

      <button
        type="button"
        onClick={() => { disconnect(); setLoggedOut(true) }}
        className="w-full py-3 rounded-full border border-brand-danger text-brand-danger font-semibold flex items-center justify-center gap-2 bg-red-50"
      >
        <LogOut size={18} />
        Log out securely
      </button>

      <div className="text-center text-[12px] text-brand-muted mt-3">App Version 4.2.1</div>
    </div>
  )
}

function ProfileRow({ icon, tone, title, onClick }: { icon: typeof User; tone: 'green' | 'gold' | 'muted'; title: string; onClick: () => void }) {
  return (
    <div className="px-4">
      <ListRow
        icon={<IconBadge icon={icon} tone={tone} />}
        title={title}
        right={<ChevronRight size={18} className="text-brand-muted" />}
        onClick={onClick}
      />
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-brand-divider mx-4" />
}
