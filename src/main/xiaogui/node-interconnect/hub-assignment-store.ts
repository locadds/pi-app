import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentEnvelopeV1,
} from '@shared/xiaogui-node-contract'

export interface HubAssignmentLedgerRecordV1 {
  readonly taskIdentityDigest: string
  readonly envelope: XiaoguiAssignmentEnvelopeV1
  readonly claimed: boolean
  readonly resultDigest?: string
  readonly reasonCode?: string
}

export interface HubAssignmentStoreV1 {
  load(): Promise<readonly HubAssignmentLedgerRecordV1[]>
  replace(records: readonly HubAssignmentLedgerRecordV1[]): Promise<void>
}

export function xiaoguiTaskIdentityDigestV1(taskId: string): string {
  return `sha256:${createHash('sha256').update(taskId).digest('hex')}`
}

export function createInMemoryHubAssignmentStoreV1(
  seed: readonly HubAssignmentLedgerRecordV1[] = [],
): HubAssignmentStoreV1 {
  let records = cloneAndValidate(seed)
  return {
    async load() { return clone(records) },
    async replace(next) { records = cloneAndValidate(next) },
  }
}

export function createJsonFileHubAssignmentStoreV1(filePath: string): HubAssignmentStoreV1 {
  let writeQueue = Promise.resolve()
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { records?: unknown }
        if (!Array.isArray(parsed.records)) throw new Error('HUB_ASSIGNMENT_STORE_INVALID')
        return cloneAndValidate(parsed.records as HubAssignmentLedgerRecordV1[])
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    async replace(records) {
      const snapshot = cloneAndValidate(records)
      writeQueue = writeQueue.then(() => save(filePath, snapshot))
      return writeQueue
    },
  }
}

export function createXiaoguiLanHubAssignmentStoreForUserDataV1(userDataDir: string): HubAssignmentStoreV1 {
  return createJsonFileHubAssignmentStoreV1(
    join(userDataDir, 'xiaogui', 'node-hub', 'v1', 'assignment-ledger.json'),
  )
}

function cloneAndValidate(records: readonly HubAssignmentLedgerRecordV1[]): HubAssignmentLedgerRecordV1[] {
  for (const record of records) assertRecord(record)
  const assignmentIds = new Set<string>()
  const taskIds = new Set<string>()
  for (const record of records) {
    if (assignmentIds.has(record.envelope.assignmentId) || taskIds.has(record.envelope.taskId)) {
      throw new Error('HUB_ASSIGNMENT_STORE_DUPLICATE_IDENTITY')
    }
    assignmentIds.add(record.envelope.assignmentId)
    taskIds.add(record.envelope.taskId)
  }
  return clone([...records])
}

function assertRecord(record: HubAssignmentLedgerRecordV1): void {
  if (!validateXiaoguiNodePublicDtoV1(record).ok) throw new Error('HUB_ASSIGNMENT_STORE_PUBLIC_DTO_LEAK')
  if (record.taskIdentityDigest !== xiaoguiTaskIdentityDigestV1(record.envelope.taskId)) {
    throw new Error('HUB_ASSIGNMENT_STORE_TASK_IDENTITY_INVALID')
  }
  if (typeof record.claimed !== 'boolean') throw new Error('HUB_ASSIGNMENT_STORE_CLAIM_INVALID')
  if (!isSafeOpaqueId(record.envelope.taskId) || !isSafeOpaqueId(record.envelope.payloadRef.artifactId)) {
    throw new Error('HUB_ASSIGNMENT_STORE_OPAQUE_ID_INVALID')
  }
  if (record.resultDigest && !isDigest(record.resultDigest)) throw new Error('HUB_ASSIGNMENT_STORE_RESULT_INVALID')
  if (record.reasonCode && !/^[A-Z][A-Z0-9_]{2,63}$/.test(record.reasonCode)) {
    throw new Error('HUB_ASSIGNMENT_STORE_REASON_INVALID')
  }
}

function isSafeOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isDigest(value: string): boolean {
  return /^sha256:[A-Za-z0-9._-]+$/.test(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function save(filePath: string, records: readonly HubAssignmentLedgerRecordV1[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(
    tempPath,
    JSON.stringify({ version: 'xiaogui.hub-assignment-ledger.v1', records }, null, 2),
    'utf8',
  )
  await rename(tempPath, filePath)
}
