import { isAbsolute, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { OMP_ACP_APPROVED_VERSION_V1 } from './omp-acp-adapter'
import { resolveOmpPrivateLayoutV1 } from './omp-private-layout'

describe('Oh My Pi private runtime layout', () => {
  it('places the pinned package inside a private node_modules dependency graph', () => {
    const userDataDir = isAbsolute(process.cwd()) ? process.cwd() : join('D:\\', 'xiaogui-test')
    const layout = resolveOmpPrivateLayoutV1(userDataDir)

    expect(layout.runtimeRoot).toBe(join(
      userDataDir,
      'xiaogui',
      'agent-runtime',
      `omp-v${OMP_ACP_APPROVED_VERSION_V1}`,
      'install',
    ))
    expect(layout.packageRoot).toBe(join(
      layout.runtimeRoot,
      'node_modules',
      '@oh-my-pi',
      'pi-coding-agent',
    ))
    expect(layout.receiptPath).toBe(join(layout.runtimeRoot, 'receipt-v1.json'))
  })
})
