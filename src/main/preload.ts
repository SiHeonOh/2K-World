import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { API_CHANNELS, OPEN_DROPPED_CHANNEL, PUSH_CHANNEL, type Bridge, type PushNote } from '@shared/api'

const allowed = new Set<string>(API_CHANNELS)

const bridge: Bridge = {
  invoke: (channel, ...args) => {
    if (!allowed.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  openDroppedFile: (file) => ipcRenderer.invoke(OPEN_DROPPED_CHANNEL, webUtils.getPathForFile(file)),
  onPush: (listener) => {
    // Only the note reaches the page, never the IPC event (and with it the sender).
    const handler = (_event: IpcRendererEvent, note: PushNote) => listener(note)
    ipcRenderer.on(PUSH_CHANNEL, handler)
    return () => void ipcRenderer.removeListener(PUSH_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld('twok', bridge)
