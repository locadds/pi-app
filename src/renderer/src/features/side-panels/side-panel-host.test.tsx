import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})
vi.mock('@renderer/xiaogui/components/TemplateLibraryView', () => ({
  TemplateLibraryView: ({ compact }: { compact?: boolean }) => (
    <div data-testid="template-library-panel" data-compact={String(compact)}>
      本机模板库
    </div>
  ),
}))

import { SidePanelHost } from './side-panel-host'

afterEach(cleanup)

describe('SidePanelHost template library', () => {
  it('在右侧栏以紧凑布局渲染本机模板库', async () => {
    render(
      <SidePanelHost
        item={{
          id: 'template-library',
          fallbackLabel: '模板库',
          description: '本机模板与历史版本',
          icon: 'BookOpen',
          source: 'core',
        }}
      />,
    )

    expect(await screen.findByTestId('template-library-panel')).toHaveAttribute('data-compact', 'true')
  })
})
