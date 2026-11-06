import { NativeEventEmitter, NativeModules } from 'react-native'

interface NativeAudioProgress {
  id: string
  bytesWritten: number
  contentLength: number
}

export interface NativeAudioResult {
  statusCode: number
  bytesWritten: number
  extension: string
}

interface AudioModule {
  addListener: (event: string) => void
  removeListeners: (count: number) => void
  downloadAudioFile: (
    id: string, url: string, outputPath: string, headers: Record<string, string>
  ) => Promise<NativeAudioResult>
  cancelAudioDownload: (id: string) => void
}

const nativeAudioModule = NativeModules.UtilsModule as AudioModule
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36'

export const cancelNativeAudioDownload = (id: string) => {
  if (typeof nativeAudioModule?.cancelAudioDownload !== 'function') { return }
  nativeAudioModule.cancelAudioDownload(id)
}

/**
 * The download is handled by a Java HttpURLConnection worker. Unlike
 * react-native-fs, this native method shares the already-working UtilsModule
 * with the official player and avoids JS-side audio buffers.
 */
export const downloadAudioNative = async(
  id: string,
  url: string,
  path: string,
  headers: Record<string, string> | undefined,
  onProgress: (received: number, total: number) => void,
): Promise<NativeAudioResult> => {
  if (typeof nativeAudioModule?.downloadAudioFile !== 'function') {
    throw new Error('Native audio module was not registered; install the latest APK')
  }
  const emitter = new NativeEventEmitter(nativeAudioModule)
  const subscription = emitter.addListener('lx-download-progress', (event: NativeAudioProgress) => {
    if (event.id === id) { onProgress(event.bytesWritten, event.contentLength) }
  })
  try {
    return await nativeAudioModule.downloadAudioFile(
      id,
      url,
      path,
      { 'User-Agent': DEFAULT_UA, ...headers },
    )
  } finally {
    subscription.remove()
  }
}
