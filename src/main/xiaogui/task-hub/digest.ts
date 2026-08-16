import { createHash } from 'node:crypto'

import type { InitialPlanDraftInputV1, InitialPlanTaskInputV1 } from '@shared/xiaogui-collaboration-hub'

export interface CanonicalPlanTaskV1 {
  taskKey: string
  title: string
  summary?: string
  dependsOn: string[]
}

export interface CanonicalPlanDraftV1 {
  objective: string
  tasks: CanonicalPlanTaskV1[]
}

export type DraftValidationResultV1 =
  | { ok: true; draft: CanonicalPlanDraftV1; digest: string }
  | { ok: false; reason: string }

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function canonicalizePlanDraft(draft: InitialPlanDraftInputV1): DraftValidationResultV1 {
  const objective = cleanString(draft.objective)
  if (!objective) return { ok: false, reason: 'objective_required' }
  if (!Array.isArray(draft.tasks) || draft.tasks.length === 0) return { ok: false, reason: 'tasks_required' }

  const seen = new Set<string>()
  const tasks: CanonicalPlanTaskV1[] = []
  for (const task of draft.tasks) {
    const taskKey = cleanString(task.taskKey)
    const title = cleanString(task.title)
    if (!taskKey || !title) return { ok: false, reason: 'task_key_title_required' }
    if (seen.has(taskKey)) return { ok: false, reason: 'duplicate_task_key' }
    seen.add(taskKey)
    const dependsOn = Array.from(new Set((task.dependsOn ?? []).map(cleanString).filter(Boolean))).sort()
    tasks.push({
      taskKey,
      title,
      ...(cleanString(task.summary) ? { summary: cleanString(task.summary) } : {}),
      dependsOn,
    })
  }

  const taskKeys = new Set(tasks.map((task) => task.taskKey))
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskKeys.has(dependency)) return { ok: false, reason: 'unknown_dependency' }
      if (dependency === task.taskKey) return { ok: false, reason: 'cycle' }
    }
  }

  if (hasCycle(tasks)) return { ok: false, reason: 'cycle' }

  const canonical = {
    objective,
    tasks: tasks.sort((a, b) => (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0)),
  }
  return { ok: true, draft: canonical, digest: digestJson(canonical) }
}

export function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function payloadDigest(value: unknown): string {
  return digestJson(value)
}

function hasCycle(tasks: InitialPlanTaskInputV1[]): boolean {
  const graph = new Map<string, string[]>()
  for (const task of tasks) graph.set(task.taskKey, task.dependsOn ?? [])
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(taskKey: string): boolean {
    if (visited.has(taskKey)) return false
    if (visiting.has(taskKey)) return true
    visiting.add(taskKey)
    for (const dependency of graph.get(taskKey) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(taskKey)
    visited.add(taskKey)
    return false
  }

  return tasks.some((task) => visit(task.taskKey))
}
