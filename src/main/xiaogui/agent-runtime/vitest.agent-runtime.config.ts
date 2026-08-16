import { resolve } from 'node:path'

export default {
  test: {
    environment: 'node',
    include: [
      'packages/shared/xiaogui-agent-runtime.test.ts',
      'src/main/xiaogui/agent-runtime/**/*.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@shared': resolve('packages/shared'),
    },
  },
}
