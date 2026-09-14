import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { WorkReportDraftV1 } from '@shared/xiaogui-work-report-docx'

import { inspectSafeDocxArchiveV1 } from './docx-safety'
import { renderWorkReportArtifactV1 } from './work-report-docx-service'

describe('renderWorkReportArtifactV1', () => {
  it('renders a safe DOCX and returns the normalized plan summary for the same bytes', async () => {
    const draft: WorkReportDraftV1 = {
      title: '  最小工作报告  ',
      sections: [
        {
          heading: ' 概要 ',
          paragraphs: [' 正文 '],
          bullets: [' 要点 '],
        },
      ],
    }
    const normalized: WorkReportDraftV1 = {
      title: '最小工作报告',
      sections: [{ heading: '概要', paragraphs: ['正文'], bullets: ['要点'] }],
    }

    const artifact = await renderWorkReportArtifactV1(draft)
    const archive = await inspectSafeDocxArchiveV1(artifact.content)
    const documentXml = await archive.zip.file('word/document.xml')!.async('string')

    expect(artifact.plan).toMatchObject({
      planVersion: 1,
      sectionCount: 1,
      paragraphCount: 1,
      bulletCount: 1,
      characterCount: '最小工作报告概要正文要点'.length,
      preview: normalized,
      requiresSecondConfirmation: true,
      previewSha256: createHash('sha256').update(artifact.content).digest('hex'),
    })
    expect(archive.entryCount).toBeGreaterThan(0)
    expect(documentXml).toContain('最小工作报告')
    expect(documentXml).toContain('要点')
  })

  it('rejects an empty draft', async () => {
    await expect(
      renderWorkReportArtifactV1({ title: '空报告', sections: [] }),
    ).rejects.toMatchObject({ code: 'REPORT_DOCX_DRAFT_INVALID' })
  })
})
