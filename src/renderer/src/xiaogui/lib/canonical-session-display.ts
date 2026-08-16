import type {
  CanonicalSessionAddressScopeV1,
  SessionMode,
} from '@shared/xiaogui-session-scope'

import { XIAOGUI_MODES } from '../stores/xiaogui-store'

export interface CanonicalSessionDisplayItemV1<T> {
  item: T
  scope: CanonicalSessionAddressScopeV1
}

export interface CanonicalSessionDisplayGroupV1<T> {
  key: SessionMode
  label: string
  items: T[]
  collaborationAvailable: boolean
}

const MODE_DISPLAY_ORDER: readonly SessionMode[] = ['WORK', 'DESIGN', 'CODING']

const MODE_LABELS = new Map<SessionMode, string>(
  XIAOGUI_MODES.map(({ id, zhLabel }) => [id, zhLabel]),
)

/** DESIGN remains visible, but its collaboration entry is reserved for later research. */
export function canShowCollaborationEntry(mode: SessionMode): boolean {
  return mode !== 'DESIGN'
}

/**
 * Project canonical scopes into stable sidebar groups without deriving identity
 * or ownership in the renderer.
 */
export function groupCanonicalSessionsByMode<T>(
  entries: readonly CanonicalSessionDisplayItemV1<T>[],
): CanonicalSessionDisplayGroupV1<T>[] {
  const grouped = new Map<SessionMode, T[]>()

  for (const { item, scope } of entries) {
    const items = grouped.get(scope.sessionMode)
    if (items) items.push(item)
    else grouped.set(scope.sessionMode, [item])
  }

  return MODE_DISPLAY_ORDER.flatMap((mode) => {
    const items = grouped.get(mode)
    if (!items) return []
    return [
      {
        key: mode,
        label: MODE_LABELS.get(mode) ?? mode,
        items,
        collaborationAvailable: canShowCollaborationEntry(mode),
      },
    ]
  })
}
