import ReactDOM from 'react-dom/client'
import '@univerjs/design/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/ui/lib/index.css'
import { OfficeViewerApp } from './app'
import { createOfficeParentBridgeV1 } from './core/parent-bridge'
import './viewer.css'

// 必须早于 React effect 建立监听，否则 iframe load 与大体积 Univer 初始化之间
// 存在一次性 MessagePort 握手丢失的竞态。
const parentBridge = createOfficeParentBridgeV1()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <OfficeViewerApp parentBridge={parentBridge} />,
)
