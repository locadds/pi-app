import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveXiaoguiConfig, resolveXiaoguiRuntime } from './config'

describe('resolveXiaoguiRuntime（小规 runtime 定位）', () => {
  const prevRepo = process.env['XIAOGUI_REPO']
  const prevRuntimeDir = process.env['XIAOGUI_RUNTIME_DIR']
  const prevPython = process.env['XIAOGUI_PYTHON']
  const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const dirs: string[] = []

  function tempDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    dirs.push(dir)
    return dir
  }

  function setResourcesPath(value: string | undefined): void {
    if (value === undefined) {
      Reflect.deleteProperty(process, 'resourcesPath')
      return
    }
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value,
    })
  }

  afterEach(() => {
    const restore: [string, string | undefined][] = [
      ['XIAOGUI_REPO', prevRepo],
      ['XIAOGUI_RUNTIME_DIR', prevRuntimeDir],
      ['XIAOGUI_PYTHON', prevPython],
    ]
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
    else Reflect.deleteProperty(process, 'resourcesPath')
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('显式 XIAOGUI_RUNTIME_DIR 优先，且不会补开发机默认仓库路径', () => {
    delete process.env['XIAOGUI_REPO']
    process.env['XIAOGUI_RUNTIME_DIR'] = 'D:/runtime/explicit'
    setResourcesPath(undefined)

    const runtime = resolveXiaoguiRuntime()
    expect(runtime.source).toBe('env-runtime-dir')
    expect(runtime.repoRoot).toBe('')
    expect(runtime.pythonCwd).toBe('D:/runtime/explicit')
    expect(runtime.error).toBeNull()
  })

  it('显式 XIAOGUI_REPO 派生 python runtime', () => {
    delete process.env['XIAOGUI_RUNTIME_DIR']
    process.env['XIAOGUI_REPO'] = 'D:/xiaogui/repo'
    setResourcesPath(undefined)

    const cfg = resolveXiaoguiConfig()
    expect(cfg.runtimeSource).toBe('env-repo')
    expect(cfg.repoRoot).toBe('D:/xiaogui/repo')
    expect(cfg.pythonCwd).toBe(join('D:/xiaogui/repo', 'python'))
  })

  it('未显式配置时回退 process.resourcesPath/xiaogui/python', () => {
    delete process.env['XIAOGUI_REPO']
    delete process.env['XIAOGUI_RUNTIME_DIR']
    const resources = tempDir('xg-resources-')
    mkdirSync(join(resources, 'xiaogui', 'python'), { recursive: true })
    setResourcesPath(resources)

    const cfg = resolveXiaoguiConfig()
    expect(cfg.runtimeSource).toBe('bundled-resource')
    expect(cfg.repoRoot).toBe(join(resources, 'xiaogui'))
    expect(cfg.pythonCwd).toBe(join(resources, 'xiaogui', 'python'))
  })

  it('未配置且未找到内置资源时返回结构化缺失错误，不出现开发机绝对路径', () => {
    delete process.env['XIAOGUI_REPO']
    delete process.env['XIAOGUI_RUNTIME_DIR']
    setResourcesPath(undefined)

    const cfg = resolveXiaoguiConfig()
    expect(cfg.runtimeSource).toBe('missing')
    expect(cfg.repoRoot).toBe('')
    expect(cfg.pythonCwd).toBeNull()
    expect(cfg.runtimeError).toContain('小规 runtime 未配置')
    expect(JSON.stringify(cfg)).not.toContain('小试牛刀')
  })
})
