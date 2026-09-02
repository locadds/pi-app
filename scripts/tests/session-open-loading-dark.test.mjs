import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const css = readFileSync(join(root, 'src/renderer/src/styles/globals.css'), 'utf8')
const view = readFileSync(
  join(root, 'src/renderer/src/features/timeline/session-open-loading.tsx'),
  'utf8',
)

describe('session open loading dark theme', () => {
  it('should_define_xiaogui_loader_tokens_for_light_and_dark_themes', () => {
    assert.match(css, /:root\s*\{[\s\S]*--xiaogui-loader-ink:\s*#111318/i)
    assert.match(css, /:root\s*\{[\s\S]*--xiaogui-loader-node:\s*#e8463a/i)
    assert.match(css, /\.dark\s*\{[\s\S]*--xiaogui-loader-ink:\s*#f7f5ef/i)
    assert.match(css, /\.xiaogui-loader-card\s*\{[\s\S]*background:\s*transparent/i)
  })

  it('should_not_hardcode_light_fallbacks_in_session_open_loading', () => {
    assert.doesNotMatch(view, /#f3f3f3/i)
    assert.doesNotMatch(view, /#1a1a1a/i)
    assert.match(view, /xiaogui-session-loading/)
    assert.match(view, /xiaogui-loader__small/)
    assert.match(view, /xiaogui-loader__gui/)
    assert.match(view, /xiaogui-loader__node/)
    assert.match(view, /xiaogui-loader__path/)
  })
})
