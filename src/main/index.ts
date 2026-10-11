import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron'
import { API_CHANNELS, OPEN_DROPPED_CHANNEL, PUSH_CHANNEL, type AppInfo, type DialogLabels, type Envelope } from '@shared/api'
import { createContext, type AppContext } from './context'
import { AppError, errorShape } from './errors'
import { createHandlers, openDroppedHandler, withStory, type Handlers } from './handlers'
import { SPREADSHEET_EXTENSIONS } from './importer'
import { defaultsDir, iconPath, resolveDataDir, setDataDirPointer } from './paths'

let context: AppContext
let mainWindow: BrowserWindow | null = null

function buildContext(dataDir = resolveDataDir()): AppContext {
  // Background changes reach the window as notes; with no window open there's no one to tell.
  return createContext(dataDir, defaultsDir(), app.getVersion(), (note) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(PUSH_CHANNEL, note)
  })
}

const rendererFile = () => join(__dirname, '../renderer/index.html')
const devUrl = () => (!app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined)

function appInfo(): AppInfo {
  return { version: app.getVersion(), dataDir: context.dataDir, isPackaged: app.isPackaged }
}

async function pickFile(kind: 'spreadsheet' | 'template', labels: DialogLabels): Promise<string | null> {
  const extensions = kind === 'spreadsheet' ? SPREADSHEET_EXTENSIONS : ['json']
  const options = { title: labels.title, properties: ['openFile' as const], filters: [{ name: labels.filterName, extensions }] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function pickFolder(labels: DialogLabels): Promise<string | null> {
  const options = { title: labels.title, properties: ['openDirectory' as const, 'createDirectory' as const] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

function switchDataDir(dir: string): AppInfo {
  const next = buildContext(dir)
  context.ai.closeAll()
  context.leagues.closeAll()
  setDataDirPointer(dir)
  context = next
  // The new folder's AI service starts out unchecked.
  void context.ai.refresh()
  return appInfo()
}

/** Our page: the dev server's origin, or exactly the bundled index.html. */
function isOwnPage(url: string): boolean {
  try {
    const u = new URL(url)
    const dev = devUrl()
    if (dev) return u.origin === new URL(dev).origin
    const own = pathToFileURL(rendererFile())
    return u.protocol === 'file:' && u.pathname.toLowerCase() === own.pathname.toLowerCase()
  } catch {
    return false
  }
}

/** Only our own window's top frame may call the API. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || !mainWindow || frame !== mainWindow.webContents.mainFrame) return false
  return isOwnPage(frame.url)
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Envelope<unknown>> => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'invalid-input', message: 'untrusted sender' } }
    try {
      return { ok: true, value: await fn(...args) }
    } catch (e) {
      if (!(e instanceof AppError)) console.error(`[ipc] ${channel} failed`, e)
      // Known database and disk errors get their own codes, so they're shown in Korean.
      return { ok: false, error: errorShape(e) }
    }
  })
}

function registerIpc(handlers: Handlers): void {
  for (const channel of API_CHANNELS) handle(channel, handlers[channel] as (...a: unknown[]) => unknown)
  handle(OPEN_DROPPED_CHANNEL, openDroppedHandler({ context: () => context }))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: '2K World',
    icon: iconPath(),
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // Links open in the real browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows our page (dev reloads included).
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnPage(url)) event.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isOwnPage(event.url)) event.preventDefault()
  })
  // The page's process ending (a crash, out of memory) leaves a blank window: say so and offer to load it again.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] the page stopped', details)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: '2K World',
        message: '화면이 멈췄어요.',
        detail: `화면을 그리던 프로세스가 끝났어요 (${details.reason}). 다시 불러오면 이어서 쓸 수 있어요. 저장한 내용은 그대로 있어요.`,
        buttons: ['다시 불러오기', '닫기'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return
        if (response === 0) win.webContents.reload()
        else win.close()
      })
  })

  const dev = devUrl()
  if (dev) void win.loadURL(dev)
  else void win.loadFile(rendererFile())
}

if (!app.requestSingleInstanceLock()) {
  // A second copy would open the same SQLite files; hand over to the first one.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    if (app.isPackaged) Menu.setApplicationMenu(null)
    // Electron grants camera, notifications etc. by default; this app needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    context = buildContext()
    registerIpc(
      withStory(
        createHandlers({
          context: () => context,
          appInfo,
          pickFile,
          pickFolder,
          openFolder: (path) => void shell.openPath(path),
          showItem: (path) => shell.showItemInFolder(path),
          switchDataDir,
        }),
        () => context,
      ),
    )
    createWindow()
    // Look for Claude Code in the background; the screens ask for the result.
    void context.ai.refresh()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((e: unknown) => {
    // Without a window the process would linger and hold the single-instance lock.
    dialog.showErrorBox('2K World', `시작하지 못했어요.

${e instanceof Error ? e.message : String(e)}`)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => {
    context?.ai.closeAll()
    context?.leagues.closeAll()
  })
}
