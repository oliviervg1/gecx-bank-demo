import { Sparkles, MicOff, RefreshCw, AudioLines, Mic } from 'lucide-react'
import { useAgent } from '../agent/AgentProvider'
import { useHoldToTalk } from '../agent/useHoldToTalk'

type Visual = {
  label: string
  icon: React.ReactNode
  className: string
  onClick: (() => void) | null
}

function visualFor(
  connState: ReturnType<typeof useAgent>['connState'],
  micState: ReturnType<typeof useAgent>['micState'],
  pushToTalk: boolean,
  actions: { startMic: () => void; stopMic: () => void; reconnect: () => void },
): Visual {
  if (connState === 'connecting') {
    return {
      label: 'Connecting…',
      icon: <Sparkles size={18} className="animate-pulse" />,
      className: 'bg-brand-green text-white opacity-70',
      onClick: null,
    }
  }
  if (connState === 'error') {
    return {
      label: 'Retry',
      icon: <RefreshCw size={18} />,
      className: 'bg-white border border-brand-danger text-brand-danger',
      onClick: actions.reconnect,
    }
  }
  if (micState === 'muted') {
    return {
      label: 'Mic blocked',
      icon: <MicOff size={18} />,
      className: 'bg-brand-divider text-brand-muted',
      onClick: actions.startMic,
    }
  }
  // Push-to-talk: transmitting. Gold and scaled so it is unmistakable from the
  // back of a room that the mic is live.
  if (micState === 'held') {
    return {
      label: 'Release to send',
      icon: <Mic size={18} className="animate-pulse" />,
      className: 'bg-brand-gold text-brand-text scale-105',
      onClick: null,
    }
  }
  if (micState === 'listening') {
    return {
      label: 'Listening',
      icon: <AudioLines size={18} className="animate-pulse" />,
      className: 'bg-brand-green text-white',
      onClick: actions.stopMic,
    }
  }
  if (micState === 'speaking') {
    return {
      label: 'Speaking',
      icon: <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />,
      className: 'bg-brand-green text-white',
      // In push-to-talk the mic is already silent while the agent speaks, so
      // there is nothing to stop; the button is inert rather than misleading.
      onClick: pushToTalk ? null : actions.stopMic,
    }
  }
  // ready + idle
  return {
    label: pushToTalk ? 'Hold to talk' : 'Talk to concierge',
    icon: <Sparkles size={18} className="text-brand-gold" />,
    className: 'bg-brand-green text-white',
    onClick: pushToTalk ? null : actions.startMic,
  }
}

export function ConciergePill() {
  const agent = useAgent()
  const holdable = agent.pushToTalk && agent.connState === 'ready' && agent.micState !== 'muted'
  const hold = useHoldToTalk({
    enabled: holdable,
    onBegin: agent.beginTalking,
    onEnd: agent.endTalking,
  })

  const v = visualFor(agent.connState, agent.micState, agent.pushToTalk, {
    startMic: () => { void agent.startMic() },
    stopMic: agent.stopMic,
    reconnect: agent.reconnect,
  })

  const holdProps = holdable ? hold : {}

  return (
    <button
      type="button"
      onClick={v.onClick ?? undefined}
      disabled={v.onClick === null && !holdable}
      // touch-action:none stops a drag off the pill turning into a page scroll
      // and swallowing the pointerup.
      style={holdable ? { touchAction: 'none' } : undefined}
      title={agent.pushToTalk ? 'Hold the pill or the spacebar to talk' : undefined}
      {...holdProps}
      className={
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full ' +
        'text-[13px] font-semibold leading-none transition-transform ' +
        v.className
      }
    >
      {v.icon}
      <span>{v.label}</span>
    </button>
  )
}
