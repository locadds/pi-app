import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('E2E smoke env', () => {
  it('window.ts supports PI_E2E show path', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/window.ts'), 'utf8')
    assert.match(src, /isE2eTestMode/)
    assert.match(src, /PI_E2E/)
  })

  it('shared e2e launcher sets PI_E2E and electron executable', () => {
    const src = readFileSync(join(process.cwd(), 'e2e/helpers.ts'), 'utf8')
    assert.match(src, /PI_E2E/)
    assert.match(src, /require\('electron'\)/)
    assert.match(src, /executablePath/)
  })

  it('smoke spec uses the shared launcher', () => {
    const src = readFileSync(join(process.cwd(), 'e2e/smoke.spec.ts'), 'utf8')
    assert.match(src, /from '\.\/helpers'/)
    assert.match(src, /launchApp/)
  })
})
