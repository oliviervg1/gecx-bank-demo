import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

interface Props {
  pageKey: string
  direction: 'forward' | 'back'
  children: ReactNode
}

const SLIDE_X = 24

export function PageTransition({ pageKey, direction, children }: Props) {
  const reduced = useReducedMotion()
  const inX = direction === 'forward' ? SLIDE_X : -SLIDE_X
  const outX = direction === 'forward' ? -SLIDE_X : SLIDE_X
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={pageKey}
        initial={reduced ? { opacity: 0 } : { opacity: 0, x: inX }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, x: outX }}
        transition={
          reduced
            ? { duration: 0.08 }
            : { duration: 0.28, ease: [0.32, 0.72, 0, 1] }
        }
        style={{ height: '100%' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
