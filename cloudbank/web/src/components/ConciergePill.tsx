import type { ReactNode } from 'react'
import { Sparkles, MicOff, RefreshCw, AudioLines, Mic, PauseCircle } from 'lucide-react'
import { useAgent, type ConnState, type MicState } from '../agent/AgentProvider'
import type { SessionPhase } from '../agent/sessionMachine'
import { useHoldToTalk } from '../agent/useHoldToTalk'

interface Visual {
  label: string
  icon: ReactNode
  className: string
  onClick: (() => void) | null
}

function resolvePhase(
  phase: SessionPhase | undefined,
  connState: ConnState,
  micState: MicState,
): SessionPhase {
  if (phase) return phase
  if (connState === 'connecting') return 'connecting'
  if (connState === 'error') return 'error'
  if (micState === 'muted') return 'error'
  if (micState === 'held' || micState === 'listening') return 'capturing'
  if (micState === 'speaking') return 'agentSpeaking'
  if (connState === 'idle') return 'disconnected'
  return 'ready'
}

function visualFor(
  phase: SessionPhase,
  micState: MicState,
  micDenied: boolean,
  pushToTalk: boolean,
  actions: { startMic: () => void; stopMic: () => void; reconnect: () => void },
): Visual {
  if (phase === 'connecting') {
    return {
      label: 'Connecting…',
      icon: (
        <Sparkles
          size={16}
          aria-hidden="true"
          className="animate-pulse motion-reduce:animate-none"
        />
      ),
      className: 'bg-brand-green text-white opacity-75',
      onClick: null,
    }
  }
  if (phase === 'paused') {
    return {
      label: pushToTalk ? 'Session paused · Hold to talk' : 'Session paused · Resume',
      icon: <PauseCircle size={16} aria-hidden="true" className="text-brand-gold-text" />,
      className: 'bg-white border border-brand-border-strong text-brand-text',
      onClick: pushToTalk ? null : actions.reconnect,
    }
  }
  if (micDenied || micState === 'muted') {
    return {
      label: 'Microphone off',
      icon: <MicOff size={16} aria-hidden="true" />,
      className: 'bg-white border border-brand-border-strong text-brand-muted',
      onClick: pushToTalk ? null : actions.startMic,
    }
  }
  if (phase === 'error') {
    return {
      label: 'Reconnect',
      icon: <RefreshCw size={16} aria-hidden="true" />,
      className:
        'bg-white border border-brand-border-strong text-brand-text hover:border-brand-green',
      onClick: actions.reconnect,
    }
  }
  if (phase === 'capturing') {
    if (pushToTalk) {
      return {
        label: 'Release to send',
        icon: (
          <Mic
            size={16}
            aria-hidden="true"
            className="animate-pulse motion-reduce:animate-none"
          />
        ),
        className: 'bg-brand-gold text-brand-text',
        onClick: null,
      }
    }
    return {
      label: 'Listening',
      icon: (
        <AudioLines
          size={16}
          aria-hidden="true"
          className="animate-pulse motion-reduce:animate-none"
        />
      ),
      className: 'bg-brand-green text-white',
      onClick: actions.stopMic,
    }
  }
  if (phase === 'thinking') {
    return {
      label: 'Thinking…',
      icon: (
        <Sparkles
          size={16}
          aria-hidden="true"
          className="text-brand-gold animate-pulse motion-reduce:animate-none"
        />
      ),
      className: 'bg-brand-green text-white',
      onClick: null,
    }
  }
  if (phase === 'agentSpeaking' || phase === 'drainingFarewell') {
    return {
      label: 'Speaking',
      icon: (
        <span
          aria-hidden="true"
          className="inline-block w-2 h-2 rounded-full bg-brand-gold animate-pulse motion-reduce:animate-none"
        />
      ),
      className: 'bg-brand-green text-white',
      onClick: pushToTalk ? null : actions.stopMic,
    }
  }
  return {
    label: pushToTalk ? 'Hold to talk' : 'Talk to concierge',
    icon: <Sparkles size={16} aria-hidden="true" className="text-brand-gold" />,
    className: 'bg-brand-green text-white',
    onClick: pushToTalk ? null : actions.startMic,
  }
}

function tooltipFor(
  phase: SessionPhase,
  micState: MicState,
  micDenied: boolean,
  pushToTalk: boolean,
): string | undefined {
  if (micDenied || micState === 'muted') {
    return pushToTalk
      ? 'Allow microphone access in your browser, then hold to talk'
      : 'Allow microphone access in your browser to talk'
  }
  if (phase === 'error') {
    return 'Select Reconnect to start a new concierge session'
  }
  if (phase === 'paused') {
    return pushToTalk
      ? 'Hold or select this button, or hold the Spacebar, to resume'
      : 'Select to resume your concierge session'
  }
  if (pushToTalk) {
    return phase === 'capturing'
      ? 'Release, click, or press Enter to send'
      : 'Hold or click this button, or hold the Spacebar, to talk'
  }
  return phase === 'capturing' ? 'Select to stop listening' : 'Select to start listening'
}

export function ConciergePill() {
  const agent = useAgent()
  const phase = resolvePhase(agent.phase, agent.connState, agent.micState)
  const micDenied = Boolean(agent.micDenied) || agent.micState === 'muted'
  const isCapturing = phase === 'capturing'
  const holdable =
    agent.pushToTalk && phase !== 'connecting' && !(phase === 'error' && !micDenied)

  const hold = useHoldToTalk({
    enabled: holdable,
    onBegin: agent.beginTalking,
    onEnd: agent.endTalking,
    allowClickToggle: true,
    isCapturing,
    canClickStart: phase !== 'agentSpeaking' && phase !== 'drainingFarewell',
  })

  const v = visualFor(phase, agent.micState, micDenied, agent.pushToTalk, {
    startMic: () => {
      void agent.startMic()
    },
    stopMic: agent.stopMic,
    reconnect: agent.reconnect,
  })

  const { onClick: holdClick, ...pointerHoldProps } = hold
  const effectiveOnClick = holdable ? holdClick : (v.onClick ?? undefined)
  const exposePressedState =
    holdable ||
    (!agent.pushToTalk && phase !== 'connecting' && phase !== 'error' && phase !== 'paused')

  return (
    <button
      type="button"
      data-concierge-pill="true"
      aria-pressed={exposePressedState ? isCapturing : undefined}
      onClick={effectiveOnClick}
      disabled={effectiveOnClick === undefined && !holdable}
      style={holdable ? { touchAction: 'none' } : undefined}
      title={tooltipFor(phase, agent.micState, micDenied, agent.pushToTalk)}
      {...(holdable ? pointerHoldProps : {})}
      className={
        'min-h-9 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full ' +
        'text-[0.8125rem] font-semibold leading-none transition-colors select-none ' +
        v.className
      }
    >
      {v.icon}
      <span>{v.label}</span>
    </button>
  )
}
