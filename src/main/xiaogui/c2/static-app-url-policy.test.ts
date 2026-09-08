import { describe, expect, it } from 'vitest'

import { isC2StaticAppUrlAllowedV1 } from './static-app-url-policy'

describe('C2 static App URL policy', () => {
  it('allows only the exact artifact host and rejects prefix-confusable hosts', () => {
    expect(isC2StaticAppUrlAllowedV1('xiaogui-app://demo/1.0.0/index.html', 'demo', '1.0.0')).toBe(true)
    expect(isC2StaticAppUrlAllowedV1('xiaogui-app://demo/1.0.0/assets/main.js', 'demo', '1.0.0')).toBe(true)
    expect(isC2StaticAppUrlAllowedV1('xiaogui-app://demo.evil/1.0.0/index.html', 'demo', '1.0.0')).toBe(false)
    expect(isC2StaticAppUrlAllowedV1('xiaogui-app://demo/2.0.0/index.html', 'demo', '1.0.0')).toBe(false)
    expect(isC2StaticAppUrlAllowedV1('https://demo/1.0.0/index.html', 'demo', '1.0.0')).toBe(false)
    expect(isC2StaticAppUrlAllowedV1('not a url', 'demo', '1.0.0')).toBe(false)
  })
})
