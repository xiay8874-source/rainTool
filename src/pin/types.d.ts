// 贴图窗口的 window.pin 类型声明(由 electron/pin-preload.ts 暴露)

export interface PinLoadData {
  id: string
  name: string
  filePath: string
}

export interface PinAPI {
  onPinLoad: (cb: (data: PinLoadData) => void) => () => void
  readFile: (filePath: string) => Promise<string | null>
  copyToClipboard: (filePath: string) => Promise<boolean>
  saveAs: (sourcePath: string, defaultName: string) => Promise<string | null>
  saveToHistory: (tabId: string, layersJson: string | null, mergedDataUrl: string | null) => Promise<boolean>
  close: (tabId: string) => Promise<boolean>
}

declare global {
  interface Window {
    pin: PinAPI
  }
}
