import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'

import { useUIStore } from '@renderer/stores/ui-store'
import type { SessionItem } from '@renderer/stores/ui-store-types'

import { ComposerCollaborationButton } from './ComposerCollaborationButton'

const scope: CanonicalSessionAddressScopeV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as CanonicalSessionAddressScopeV1['projectId'],
  sessionKey: `xgs1_${'1'.repeat(64)}` as CanonicalSessionAddressScopeV1['sessionKey'],
  sessionMode: 'WORK',
}

function sessionWith(id: string, canonicalScope?: CanonicalSessionAddressScopeV1): SessionItem {
  return {
    sessionId: id,
    title: id,
    updatedAt: 0,
    modelId: 'm',
    ...(canonicalScope ? { canonicalScope } : {}),
  }
}

let snapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  snapshot = useUIStore.getState()
})

afterEach(() => {
  cleanup()
  useUIStore.setState(snapshot, true)
})

describe('ComposerCollaborationButton', () => {
  it('当前会话无 canonicalScope 时禁用并提示先进入会话', () => {
    useUIStore.setState({
      sessions: [sessionWith('s1')],
      currentSessionId: 's1',
    })
    render(<ComposerCollaborationButton />)
    const btn = screen.getByRole('button', { name: '协作计划' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', '请先进入已建立的会话')
  })

  it('无会话列表时同样禁用', () => {
    useUIStore.setState({ sessions: [], currentSessionId: null })
    render(<ComposerCollaborationButton />)
    expect(screen.getByRole('button', { name: '协作计划' })).toBeDisabled()
  })

  it('有 canonicalScope 时点击打开右栏协作 Tab 并展开右栏', async () => {
    useUIStore.setState({
      sessions: [sessionWith('s1', scope)],
      currentSessionId: 's1',
      activePanel: 'files',
      rightPanelCollapsed: true,
      rightPanelPrefs: {
        ...useUIStore.getState().rightPanelPrefs,
        collaboration: true,
      },
    })
    const user = userEvent.setup()
    render(<ComposerCollaborationButton />)
    const btn = screen.getByRole('button', { name: '协作计划' })
    expect(btn).toBeEnabled()
    await user.click(btn)
    const state = useUIStore.getState()
    expect(state.activePanel).toBe('collaboration')
    expect(state.rightPanelCollapsed).toBe(false)
    expect(state.rightPanelPrefs.collaboration).toBe(true)
  })

  it('用户关闭协作面板时保持原生 Composer 行为', () => {
    useUIStore.setState({
      sessions: [sessionWith('s1', scope)],
      currentSessionId: 's1',
      rightPanelPrefs: {
        ...useUIStore.getState().rightPanelPrefs,
        collaboration: false,
      },
    })
    render(<ComposerCollaborationButton />)
    expect(screen.queryByRole('button', { name: '协作计划' })).toBeNull()
    expect(useUIStore.getState().rightPanelPrefs.collaboration).toBe(false)
  })
})
