import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { validateXiaoguiNodePublicDtoV1 } from '@shared/xiaogui-node-contract'

export type WorkerAssignmentLedgerStatusV1 =
  | 'AWAITING_LOCAL_APPROVAL'
  | 'RUNNING'
  | 'SETTLED'
  | 'OUTCOME_UNKNOWN'

export interface WorkerAssignmentLedgerRecordV1 {
  assignmentId: string
  leaseId: string
  attemptId: string
  status: WorkerAssignmentLedgerStatusV1
  summaryDigest: string
  updatedAt: string
  receiptDigest?: string
}

export interface WorkerAssignmentLedgerV1 {
  get(assignmentId: string): Promise<WorkerAssignmentLedgerRecordV1 | null>
  listActive(): Promise<readonly WorkerAssignmentLedgerRecordV1[]>
  upsert(record: WorkerAssignmentLedgerRecordV1): Promise<void>
}

export function createInMemoryWorkerAssignmentLedgerV1(
  seed: readonly WorkerAssignmentLedgerRecordV1[] = [],
): WorkerAssignmentLedgerV1 {
  const records = new Map(seed.map((record) => [record.assignmentId, record]))
  return {
    async get(assignmentId) {
      return records.get(assignmentId) ?? null
    },
    async listActive() {
      return [...records.values()].filter((record) => record.status === 'RUNNING' || record.status === 'AWAITING_LOCAL_APPROVAL')
    },
    async upsert(record) {
      assertLedgerRecord(record)
      records.set(record.assignmentId, record)
    },
  }
}

export function createJsonFileWorkerAssignmentLedgerV1(filePath: string): WorkerAssignmentLedgerV1 {
  return {
    async get(assignmentId) {
      const records = await load(filePath)
      return records.find((record) => record.assignmentId === assignmentId) ?? null
    },
    async listActive() {
      return (await load(filePath)).filter((record) => record.status === 'RUNNING' || record.status === 'AWAITING_LOCAL_APPROVAL')
    },
    async upsert(record) {
      assertLedgerRecord(record)
      const records = await load(filePath)
      const index = records.findIndex((candidate) => candidate.assignmentId === record.assignmentId)
      if (index >= 0) records[index] = record
      else records.push(record)
      await save(filePath, records)
    },
  }
}

export function createXiaoguiLanWorkerLedgerForUserDataV1(userDataDir: string): WorkerAssignmentLedgerV1 {
  return createJsonFileWorkerAssignmentLedgerV1(join(userDataDir, 'xiaogui', 'node-worker', 'v1', 'assignment-ledger.json'))
}

function assertLedgerRecord(record: WorkerAssignmentLedgerRecordV1): void {
  if (!record.summaryDigest.startsWith('sha256:')) throw new Error('WORKER_LEDGER_SUMMARY_DIGEST_INVALID')
  if (record.receiptDigest && !record.receiptDigest.startsWith('sha256:')) throw new Error('WORKER_LEDGER_RECEIPT_DIGEST_INVALID')
  if (!validateXiaoguiNodePublicDtoV1(record).ok) throw new Error('WORKER_LEDGER_PUBLIC_DTO_LEAK')
}

async function load(filePath: string): Promise<WorkerAssignmentLedgerRecordV1[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { records?: WorkerAssignmentLedgerRecordV1[] }
    const records = Array.isArray(parsed.records) ? parsed.records : []
    for (const record of records) assertLedgerRecord(record)
    return records
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function save(filePath: string, records: readonly WorkerAssignmentLedgerRecordV1[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, JSON.stringify({ version: 'xiaogui.worker-assignment-ledger.v1', records }, null, 2), 'utf8')
  await rename(tempPath, filePath)
}
