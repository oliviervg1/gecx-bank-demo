import type { ComponentType, HTMLAttributes } from 'react'
import type { LucideProps } from 'lucide-react'

export type IconTone = 'green' | 'gold' | 'muted'

const TONE_STYLES: Record<IconTone, { background: string; color: string }> = {
  green: { background: 'rgba(10, 77, 53, 0.1)',   color: 'rgb(10, 77, 53)' },
  gold:  { background: 'rgba(200, 155, 60, 0.12)', color: 'rgb(200, 155, 60)' },
  muted: { background: 'rgba(107, 114, 128, 0.12)', color: 'rgb(107, 114, 128)' },
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  icon: ComponentType<LucideProps>
  tone: IconTone
  size?: number   // outer diameter in px
  iconSize?: number  // icon stroke box in px
}

export function IconBadge({ icon: Icon, tone, size = 44, iconSize = 20, style, ...rest }: Props) {
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
      <Icon size={iconSize} strokeWidth={1.75} />
    </div>
  )
}
