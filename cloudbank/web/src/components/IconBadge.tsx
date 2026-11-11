import type { ComponentType, HTMLAttributes } from 'react'
import type { LucideProps } from 'lucide-react'

export type IconTone = 'green' | 'gold' | 'muted'

const TONE_STYLES: Record<IconTone, { background: string; color: string }> = {
  green: { background: 'rgba(10, 77, 53, 0.08)', color: '#0a4d35' },
  gold: { background: 'rgba(184, 137, 46, 0.12)', color: '#8a6318' },
  muted: { background: 'rgba(99, 97, 91, 0.10)', color: '#63615b' },
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  icon: ComponentType<LucideProps>
  tone: IconTone
  size?: number
  iconSize?: number
}

export function IconBadge({
  icon: Icon,
  tone,
  size = 40,
  iconSize = 18,
  style,
  ...rest
}: Props) {
  const tones = TONE_STYLES[tone]
  return (
    <div
      {...rest}
      className={`rounded-full flex items-center justify-center shrink-0 ${rest.className ?? ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: tones.background,
        color: tones.color,
        ...style,
      }}
    >
      <Icon size={iconSize} strokeWidth={1.75} aria-hidden="true" />
    </div>
  )
}
