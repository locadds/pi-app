import { describe, expect, it } from 'vitest'

import { toMainToolPath } from './worker-path-bridge'

describe('direct CODING WSL path seam', () => {
  it('preserves relative Pi paths and translates only Linux absolute paths', () => {
    expect(toMainToolPath('src/a.ts', 'Debian')).toBe('src/a.ts')
    expect(toMainToolPath('./src/a.ts', 'Debian')).toBe('./src/a.ts')
    expect(toMainToolPath('/home/user/project/src/a.ts', 'Debian'))
      .toBe('\\\\wsl.localhost\\Debian\\home\\user\\project\\src\\a.ts')
  })
})
