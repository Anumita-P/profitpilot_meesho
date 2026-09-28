import { useEffect, useState } from 'react'
import type { Goal, Mode } from '../api/types'
import { DEFAULT_GOAL } from '../components/GoalForm'

/** Goal state for a screen: seeded from the API (seller's saved goal) and editable in place. */
export function useGoal(initial: Goal | null | undefined, mode?: Mode) {
  const [goal, setGoal] = useState<Goal>(initial ?? DEFAULT_GOAL)
  const [seeded, setSeeded] = useState(false)

  useEffect(() => {
    if (initial && !seeded) {
      setGoal(mode ? { ...initial, mode } : initial)
      setSeeded(true)
    }
  }, [initial, mode, seeded])

  return [goal, setGoal] as const
}

export function goalPayload(goal: Goal) {
  return {
    target_contribution: goal.target_contribution,
    min_orders: goal.min_orders,
    max_return_rto: goal.max_return_rto,
    cash_limit: goal.cash_limit,
    mode: goal.mode,
  }
}
