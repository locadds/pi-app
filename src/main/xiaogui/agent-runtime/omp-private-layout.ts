import { isAbsolute, join, resolve } from 'node:path'

import { OMP_ACP_APPROVED_VERSION_V1 } from './omp-acp-adapter'

export interface OmpPrivateLayoutV1 {
  readonly rootDir: string
  readonly runtimeRoot: string
  readonly packageRoot: string
  readonly stateDir: string
  readonly receiptPath: string
}

/** One main-process source for OMP private install, state, and receipt paths. */
export function resolveOmpPrivateLayoutV1(userDataDir: string): OmpPrivateLayoutV1 {
  if (typeof userDataDir !== 'string' || userDataDir !== userDataDir.trim() || !isAbsolute(userDataDir)) {
    throw new Error('OMP_USER_DATA_DIR_INVALID')
  }
  const rootDir = join(resolve(userDataDir), 'xiaogui', 'agent-runtime', `omp-v${OMP_ACP_APPROVED_VERSION_V1}`)
  const runtimeRoot = join(rootDir, 'install')
  return Object.freeze({
    rootDir,
    runtimeRoot,
    packageRoot: join(runtimeRoot, 'node_modules', '@oh-my-pi', 'pi-coding-agent'),
    stateDir: join(rootDir, 'state'),
    receiptPath: join(runtimeRoot, 'receipt-v1.json'),
  })
}
