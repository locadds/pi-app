import { app } from 'electron'
import { join } from 'node:path'
import { XIAOGUI_PRODUCT_NAME } from '@shared/xiaogui-product'

// Run before stores/SDK consumers: this candidate has one persistent profile,
// shared by WORK, CODING and C2, separate from existing desktop installations.
app.setName(XIAOGUI_PRODUCT_NAME)
if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = join(app.getPath('userData'), 'pi-agent')
}
