import ReactDOM from 'react-dom/client'
import '@univerjs/design/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/ui/lib/index.css'
import { OfficeViewerApp } from './app'
import './viewer.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <OfficeViewerApp />,
)
