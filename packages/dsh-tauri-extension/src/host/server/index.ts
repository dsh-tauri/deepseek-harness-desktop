import type { ExtensionRouteDeps } from './routes/index.types'
import { defineWebServer } from 'dsh-h3'
import { desktopPreflight, desktopRequestGuard } from 'dsh-tauri'
import restart from './routes/host/restart/post'
import importApply from './routes/import/apply/post'
import importScan from './routes/import/scan/get'
import mcpCheck from './routes/mcp/check/post'
import mcpCopy from './routes/mcp/copy/post'
import mcpRemove from './routes/mcp/delete'
import mcp from './routes/mcp/get'
import mcpSave from './routes/mcp/post'
import mcpToggle from './routes/mcp/toggle/post'
import openDir from './routes/open/dir/post'
import rootsRemove from './routes/roots/delete'
import roots from './routes/roots/get'
import rootsAdd from './routes/roots/post'
import skillDelete from './routes/skill/delete'
import skill from './routes/skill/get'
import skillPolicy from './routes/skill/policy/post'
import skillSave from './routes/skill/post'
import skills from './routes/skills/get'
import skillsRefresh from './routes/skills/refresh/post'

export const server = defineWebServer<ExtensionRouteDeps>((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-extension/skills', skills)
  app.post('/api/desktop/dsh-tauri-extension/skills/refresh', skillsRefresh)
  app.get('/api/desktop/dsh-tauri-extension/skill', skill)
  app.post('/api/desktop/dsh-tauri-extension/skill', skillSave)
  app.delete('/api/desktop/dsh-tauri-extension/skill', skillDelete)
  app.post('/api/desktop/dsh-tauri-extension/skill/policy', skillPolicy)
  app.post('/api/desktop/dsh-tauri-extension/open/dir', openDir)

  app.get('/api/desktop/dsh-tauri-extension/mcp', mcp)
  app.post('/api/desktop/dsh-tauri-extension/mcp', mcpSave)
  app.delete('/api/desktop/dsh-tauri-extension/mcp', mcpRemove)
  app.post('/api/desktop/dsh-tauri-extension/mcp/toggle', mcpToggle)
  app.post('/api/desktop/dsh-tauri-extension/mcp/check', mcpCheck)
  app.post('/api/desktop/dsh-tauri-extension/mcp/copy', mcpCopy)

  app.get('/api/desktop/dsh-tauri-extension/import/scan', importScan)
  app.post('/api/desktop/dsh-tauri-extension/import/apply', importApply)

  app.get('/api/desktop/dsh-tauri-extension/roots', roots)
  app.post('/api/desktop/dsh-tauri-extension/roots', rootsAdd)
  app.delete('/api/desktop/dsh-tauri-extension/roots', rootsRemove)

  app.post('/api/desktop/dsh-tauri-extension/host/restart', restart)

  app.options('/api/desktop/dsh-tauri-extension/skills', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/skills/refresh', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/skill', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/skill/policy', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/open/dir', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/mcp', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/mcp/toggle', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/mcp/check', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/mcp/copy', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/import/scan', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/import/apply', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/roots', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-extension/host/restart', desktopPreflight)
})
