import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import type {
  TemplateIntakeDecisionV1,
  TemplateIntakeReportV1,
} from '@shared/xiaogui-work-docx-template-intake'

import { materializeConfirmedTemplateV1 } from './work-docx-template-materializer'

const databasePath = process.env.XIAOGUI_TEMPLATE_INTAKE_DB
const outputPath = process.env.XIAOGUI_TEMPLATE_MATERIALIZE_SMOKE_OUTPUT
const realSmoke = databasePath && outputPath ? it : it.skip

describe('WORK 模板物化真实样本冒烟', () => {
  realSmoke('复用最新确认报告生成无覆盖预览', async () => {
    const database = new DatabaseSync(databasePath!, { readOnly: true })
    const row = database
      .prepare(
        `SELECT source_path, source_sha256, report_json, decision_json
           FROM template_intake_reports_v1
          WHERE status = 'CONFIRMED' AND decision_json IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as
      | {
          source_path: string
          source_sha256: string
          report_json: string
          decision_json: string
        }
      | undefined
    database.close()
    expect(row).toBeDefined()
    if (!row) return

    await expect(access(outputPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    const source = await readFile(row.source_path)
    const sourceHashBefore = createHash('sha256').update(source).digest('hex')
    expect(sourceHashBefore).toBe(row.source_sha256)
    const result = await materializeConfirmedTemplateV1({
      source,
      report: JSON.parse(row.report_json) as TemplateIntakeReportV1,
      decision: JSON.parse(row.decision_json) as TemplateIntakeDecisionV1,
    })
    await writeFile(outputPath!, result.content, { flag: 'wx' })

    expect(createHash('sha256').update(await readFile(row.source_path)).digest('hex')).toBe(
      sourceHashBefore,
    )
    expect(createHash('sha256').update(await readFile(outputPath!)).digest('hex')).toBe(
      result.plan.previewSha256,
    )
    expect(result.plan.originalSourceUnchanged).toBe(true)
    expect(JSON.stringify(result.plan)).not.toContain(row.source_path)
  })
})
