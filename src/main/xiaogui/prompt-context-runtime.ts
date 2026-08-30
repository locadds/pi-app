import { existsSync } from 'node:fs'

import { createXiaoguiPromptContextResolverV1 } from './prompt-context'
import { opaqueScopeIdDeriverV1 } from './scope-derive'
import { sessionScopeResolverV1 } from './scope-service'
import { xiaogui } from './sidecar-bridge'

export const xiaoguiPromptContextResolverV1 = createXiaoguiPromptContextResolverV1({
  resolveScope: (ref) => sessionScopeResolverV1.resolve(ref),
  getMode: () => xiaogui.getMode(),
  getPhase: () => xiaogui.getExecutionPhase(),
  workspaceExists: (cwd) => !!cwd.trim() && existsSync(cwd),
  // Desktop project selection is the existing Main-process trust gate. Worker
  // verifies this fact against Pi SettingsManager before activating a Session.
  projectTrusted: () => true,
  deriveProjectId: (cwd) => opaqueScopeIdDeriverV1.deriveProject(cwd).projectId,
})
