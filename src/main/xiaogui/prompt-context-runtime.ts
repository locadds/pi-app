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
  // Main cannot observe Pi's final project trust. Send the conservative
  // candidate; Worker replaces it from ExtensionContext/SettingsManager.
  projectTrusted: () => false,
  deriveProjectId: (cwd) => opaqueScopeIdDeriverV1.deriveProject(cwd).projectId,
})
