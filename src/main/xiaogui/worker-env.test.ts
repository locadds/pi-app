import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildXiaoguiWorkerEnv } from './worker-env'

describe('buildXiaoguiWorkerEnv（worker env 注入）', () => {
  const prevRepo = process.env['XIAOGUI_REPO']
  const prevRuntimeDir = process.env['XIAOGUI_RUNTIME_DIR']
  const prevPython = process.env['XIAOGUI_PYTHON']
  const prevGuard = process.env['XIAOGUI_PHASE_GUARD']

  afterEach(() => {
    const restore: [string, string | undefined][] = [
      ['XIAOGUI_REPO', prevRepo],
      ['XIAOGUI_RUNTIME_DIR', prevRuntimeDir],
      ['XIAOGUI_PYTHON', prevPython],
      ['XIAOGUI_PHASE_GUARD', prevGuard],
    ]
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('注入 XIAOGUI_PHASE（fork 时取当时值）与 sidecar 基础定位 env', () => {
    delete process.env['XIAOGUI_RUNTIME_DIR']
    delete process.env['XIAOGUI_PYTHON']
    process.env['XIAOGUI_REPO'] = 'D:/fake/xiaogui-repo'
    const env = buildXiaoguiWorkerEnv({ executionPhase: 'EXECUTE' })
    expect(env['XIAOGUI_PHASE']).toBe('EXECUTE')
    expect(env['XIAOGUI_REPO']).toBe('D:/fake/xiaogui-repo')
    expect(env['XIAOGUI_RUNTIME_DIR']).toBe(join('D:/fake/xiaogui-repo', 'python'))
    expect(env['XIAOGUI_PYTHON']).toBe('python')
  })

  it('phase 切换后 env 随之变化（ASK → PLAN → EXECUTE）', () => {
    expect(buildXiaoguiWorkerEnv({ executionPhase: 'ASK' })['XIAOGUI_PHASE']).toBe('ASK')
    expect(buildXiaoguiWorkerEnv({ executionPhase: 'PLAN' })['XIAOGUI_PHASE']).toBe('PLAN')
    expect(buildXiaoguiWorkerEnv({ executionPhase: 'EXECUTE' })['XIAOGUI_PHASE']).toBe('EXECUTE')
  })

  it('XIAOGUI_PHASE_GUARD 默认不设置（灰度关闭），显式配置时透传', () => {
    delete process.env['XIAOGUI_PHASE_GUARD']
    const off = buildXiaoguiWorkerEnv({ executionPhase: 'ASK' })
    expect(off['XIAOGUI_PHASE_GUARD']).toBeUndefined()
    const on = buildXiaoguiWorkerEnv({
      executionPhase: 'ASK',
      hostEnv: { XIAOGUI_PHASE_GUARD: '1' },
    })
    expect(on['XIAOGUI_PHASE_GUARD']).toBe('1')
  })
})