import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PiSessionCheckpointPortV1,
  type PiSessionCheckpointWorkerGatewayV1,
} from './pi-session-checkpoint-port'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const directories: string[] = []

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'xiaogui-pi-checkpoint-'))
  directories.push(directory)
  return join(directory, 'checkpoint.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function gateway(): PiSessionCheckpointWorkerGatewayV1 {
  return {
    inspectPiSessionCheckpoint: vi.fn(async () => ({
      sessionId: 'pi_session_1',
      snapshotDigest: digest('a'),
    })),
    capturePiSessionCheckpoint: vi.fn(async (input) => ({
      sessionId: 'pi_session_1',
      snapshotRef: input.snapshotRef,
      snapshotDigest: digest('a'),
    })),
    restorePiSessionCheckpoint: vi.fn(async (input) => ({
      sessionId: 'pi_session_1',
      restoredSnapshotDigest: input.expectedDigest,
    })),
  }
}

describe('PiSessionCheckpointPortV1', () => {
  it('persists a private Attempt-to-Pi binding and recovers it after restart', async () => {
    const dbPath = temporaryDatabase()
    const firstGateway = gateway()
    const first = new PiSessionCheckpointPortV1({
      dbPath,
      worker: firstGateway,
      snapshotRefFactory: () => `xgscp_${'1'.repeat(64)}`,
    })
    first.bindAttempt({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      sessionFile: 'C:\\private\\sessions\\one.jsonl',
    })

    const captured = await first.capture({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
    })
    first.close()

    expect(captured).toEqual({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
      snapshotDigest: digest('a'),
    })
    expect(JSON.stringify(captured)).not.toContain('private')
    expect(firstGateway.capturePiSessionCheckpoint).toHaveBeenCalledWith({
      sessionFile: 'C:\\private\\sessions\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
    })

    const restartedGateway = gateway()
    const restarted = new PiSessionCheckpointPortV1({ dbPath, worker: restartedGateway })
    await expect(restarted.restore({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      snapshotRef: captured.snapshotRef,
      expectedDigest: captured.snapshotDigest,
    })).resolves.toEqual({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      restoredSnapshotDigest: digest('a'),
    })
    expect(restartedGateway.restorePiSessionCheckpoint).toHaveBeenCalledWith({
      sessionFile: 'C:\\private\\sessions\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef: captured.snapshotRef,
      expectedDigest: captured.snapshotDigest,
    })
    restarted.close()
  })

  it('fails closed for a changed binding or a snapshot owned by another Attempt', async () => {
    const dbPath = temporaryDatabase()
    const worker = gateway()
    const port = new PiSessionCheckpointPortV1({
      dbPath,
      worker,
      snapshotRefFactory: () => `xgscp_${'3'.repeat(64)}`,
    })
    port.bindAttempt({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      sessionFile: 'C:\\private\\sessions\\one.jsonl',
    })
    expect(() => port.bindAttempt({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_other',
      sessionFile: 'C:\\private\\sessions\\other.jsonl',
    })).toThrow('PI_SESSION_CHECKPOINT_BINDING_CONFLICT')
    const captured = await port.capture({ attemptId: 'attempt_1', sessionId: 'pi_session_1' })
    port.bindAttempt({
      attemptId: 'attempt_2',
      sessionId: 'pi_session_2',
      sessionFile: 'C:\\private\\sessions\\two.jsonl',
    })

    await expect(port.restore({
      attemptId: 'attempt_2',
      sessionId: 'pi_session_2',
      snapshotRef: captured.snapshotRef,
      expectedDigest: captured.snapshotDigest,
    })).rejects.toThrow('PI_SESSION_CHECKPOINT_BINDING_MISMATCH')
    expect(worker.restorePiSessionCheckpoint).not.toHaveBeenCalled()
    port.close()
  })
})
