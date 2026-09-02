import { isAbsolute, join, resolve } from 'node:path'

import { OMP_ACP_APPROVED_VERSION_V1 } from './omp-acp-adapter'

export interface OmpPrivateLayoutV1 {
  readonly rootDir: string
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
  return Object.freeze({
    rootDir,
    packageRoot: join(rootDir, 'install', 'package'),
    stateDir: join(rootDir, 'state'),
    receiptPath: join(rootDir, 'install', 'receipt-v1.json'),
  })
}
