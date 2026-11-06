import AsyncStorage from '@react-native-async-storage/async-storage'
import { getLyricInfo } from '@/core/music/online'
import { resolveDownloadUrl } from './resolver'
import { cancelNativeAudioDownload, downloadAudioNative } from './nativeTransport'
import {
  privateStorageDirectoryPath,
  selectManagedFolder,
  getManagedFolders,
  mkdir,
  moveFile,
  readDir,
  writeFile,
  unlink,
} from '@/utils/fs'

export type DownloadQuality = '128k' | '320k' | 'flac' | 'flac24bit'
export type DownloadStatus = 'waiting' | 'running' | 'paused' | 'failed' | 'completed'
export interface DownloadOptions {
  saveLyric: boolean
  translation: boolean
  romanization: boolean
}
export interface DownloadTask {
  id: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: DownloadQuality
  status: DownloadStatus
  progress: number
  received: number
  total: number
  fileName: string
  lyricStatus: 'pending' | 'saved' | 'missing' | 'disabled'
  error: string
  sourceDetail?: string
  options: DownloadOptions
}
interface SavedState {
  folder: string
  tasks: DownloadTask[]
}

const STORE_KEY = '@lx-download-mvp-v1'
const WORK_DIR = privateStorageDirectoryPath + '/lx-download-mvp'
const MAX_CONCURRENT = 2
const DEFAULT_OPTIONS: DownloadOptions = {
  saveLyric: true,
  translation: true,
  romanization: false,
}
let tasks: DownloadTask[] = []
let folder = ''
let initialized = false
let initPromise: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
const jobs = new Set<string>()
const running = new Set<string>()

const emit = () => {
  for (const listener of listeners) listener()
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void AsyncStorage.setItem(STORE_KEY, JSON.stringify({ folder, tasks } satisfies SavedState)).catch(console.error)
  }, 500)
}
// Android file names may not contain ASCII control characters.
// eslint-disable-next-line no-control-regex
const cleanName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 90) || 'Unknown'
const basename = (music: LX.Music.MusicInfoOnline) => cleanName(music.singer || 'Unknown') + ' - ' + cleanName(music.name)
const taskKey = (music: LX.Music.MusicInfoOnline, quality: DownloadQuality) => music.source + '_' + music.id + '_' + quality
const taskLive = (task: DownloadTask) => tasks.includes(task) && task.status === 'running'

export const getDownloadTasks = (): DownloadTask[] => tasks.map(t => ({ ...t }))
export const getDownloadFolder = (): string => folder
export const subscribeDownloads = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const initializeDownloads = async(): Promise<void> => {
  if (initialized) return
  if (initPromise) return initPromise
  initPromise = (async() => {
    const stored = await AsyncStorage.getItem(STORE_KEY)
    if (stored) {
      try {
        const data = JSON.parse(stored) as SavedState
        folder = typeof data.folder === 'string' ? data.folder : ''
        tasks = Array.isArray(data.tasks) ? data.tasks.filter(t => t?.id && t?.musicInfo).map(t => ({
          ...t,
          status: t.status === 'running' ? 'waiting' : t.status,
          options: { ...DEFAULT_OPTIONS, ...t.options },
        })) : []
      } catch (error) {
        console.error('Failed to read download tasks', error)
      }
    }
    initialized = true
    emit()
    pump()
  })()
  try { await initPromise } finally {
    // eslint-disable-next-line require-atomic-updates
    initPromise = null
  }
}

export const chooseDownloadFolder = async(): Promise<string> => {
  await initializeDownloads()
  const selected = await selectManagedFolder(true)
  if (!selected?.path || !selected.path.startsWith('content://')) throw new Error('请在系统文件选择器中授权文件夹')
  folder = selected.path
  emit()
  return folder
}

const validateFolder = async(): Promise<string> => {
  if (!folder) throw new Error('请先选择歌曲保存目录')
  const grants = await getManagedFolders()
  if (!grants.some(path => folder.startsWith(path) || path.startsWith(folder))) {
    throw new Error('文件夹授权已过期，请重新选择保存目录')
  }
  return folder
}

export const queueDownloads = async(musics: LX.Music.MusicInfoOnline[], quality: DownloadQuality, options: DownloadOptions = DEFAULT_OPTIONS): Promise<number> => {
  await initializeDownloads()
  if (!folder) await chooseDownloadFolder()
  await validateFolder()
  let count = 0
  for (const music of musics) {
    if (!music || music.source === 'local') continue
    const id = taskKey(music, quality)
    if (tasks.some(t => t.id === id)) continue
    tasks.unshift({
      id,
      musicInfo: JSON.parse(JSON.stringify(music)) as LX.Music.MusicInfoOnline,
      quality,
      status: 'waiting',
      progress: 0,
      received: 0,
      total: 0,
      fileName: '',
      lyricStatus: options.saveLyric ? 'pending' : 'disabled',
      error: '',
      options: { ...options },
    })
    count++
  }
  emit()
  pump()
  return count
}

export const pauseDownload = (id: string) => {
  const task = tasks.find(t => t.id === id)
  if (!task || (task.status !== 'running' && task.status !== 'waiting')) return
  task.status = 'paused'
  if (jobs.has(id)) cancelNativeAudioDownload(id)
  emit()
}

export const resumeDownload = (id: string) => {
  const task = tasks.find(t => t.id === id)
  if (!task || task.status === 'running') return
  task.status = 'waiting'
  task.error = ''
  task.sourceDetail = ''
  task.lyricStatus = task.options.saveLyric ? 'pending' : 'disabled'
  task.progress = 0
  task.received = 0
  task.total = 0
  emit()
  pump()
}

export const removeDownload = (id: string) => {
  pauseDownload(id)
  tasks = tasks.filter(t => t.id !== id)
  emit()
}

const formatLrc = (info: LX.Player.LyricInfo, opts: DownloadOptions, music: LX.Music.MusicInfoOnline): string => {
  const lines: Array<{ ms: number, text: string, priority: number }> = []
  const collect = (text: string | undefined, priority: number) => {
    if (!text) return
    for (const line of text.split(/\r?\n/)) {
      const match = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/.exec(line.trim())
      if (!match?.[4]?.trim()) continue
      const frac = (match[3] || '0').padEnd(3, '0').slice(0, 3)
      lines.push({
        ms: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(frac),
        text: match[4],
        priority,
      })
    }
  }
  collect(info.lyric, 0)
  if (opts.translation) collect(info.tlyric, 1)
  if (opts.romanization) collect(info.rlyric, 2)
  lines.sort((a, b) => a.ms - b.ms || a.priority - b.priority)
  const seen = new Set<string>()
  const body = lines.filter(line => {
    const key = line.ms + ':' + line.text
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(line => {
    const min = Math.floor(line.ms / 60000)
    const sec = Math.floor(line.ms / 1000) % 60
    const cent = Math.floor(line.ms % 1000 / 10)
    return '[' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(cent).padStart(2, '0') + ']' + line.text
  })
  if (!body.length) return info.lyric?.trim() || ''
  return '[ti:' + music.name.replace(/[\r\n\]]/g, '') + ']\n[ar:' + music.singer.replace(/[\r\n\]]/g, '') + ']\n' + body.join('\n') + '\n'
}

const saveLyrics = async(task: DownloadTask, fileBase: string, currentFolder: string) => {
  if (!task.options.saveLyric) {
    task.lyricStatus = 'disabled'
    return
  }
  try {
    const lyric = await getLyricInfo({ musicInfo: task.musicInfo, isRefresh: false })
    const lrc = formatLrc(lyric, task.options, task.musicInfo)
    if (!lrc || !/\[\d{1,2}:\d{2}/.test(lrc)) {
      task.lyricStatus = 'missing'
      return
    }
    const fileName = fileBase + '.lrc'
    const files = await readDir(currentFolder)
    if (!files.some(f => f.name === fileName)) await writeFile(currentFolder + '/' + fileName, lrc, 'utf8')
    task.lyricStatus = 'saved'
  } catch (error) {
    console.warn('Lyric export failed', error)
    task.lyricStatus = 'missing'
  }
}

const downloadOne = async(task: DownloadTask) => {
  const tmp = WORK_DIR + '/' + cleanName(task.id) + '.part'
  let stage = '准备临时文件'
  try {
    await mkdir(WORK_DIR)
    stage = '检查文件夹权限'
    const currentFolder = await validateFolder()
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!taskLive(task)) return
      stage = '解析音频地址'
      let resolved
      try {
        resolved = await resolveDownloadUrl(task.musicInfo, task.quality, attempt > 0)
      } catch (err) {
        if (attempt === 0) continue
        throw err
      }

      task.sourceDetail = resolved.detail
      emit()
      await unlink(tmp).catch(() => {})
      stage = '原生网络下载'
      jobs.add(task.id)
      let result
      try {
        result = await downloadAudioNative(
          task.id, resolved.url, tmp, resolved.headers,
          (received, total) => {
            if (!taskLive(task)) return
            task.received = received
            task.total = total
            task.progress = total > 0 ? Math.floor(100 * received / total) : 0
            emit()
          },
        )
      } catch (error) {
        if (!taskLive(task)) return
        if (attempt === 0) continue
        throw error
      } finally {
        jobs.delete(task.id)
      }
      if (!taskLive(task)) return
      if (result.statusCode !== 200 && result.statusCode !== 206) {
        if (attempt === 0) continue
        throw new Error('HTTP ' + result.statusCode)
      }

      stage = '校验音频格式'
      const ext = result.extension
      if (!['mp3', 'flac', 'ogg', 'ape', 'wav', 'm4a'].includes(ext)) {
        throw new Error('未知音频格式：' + ext)
      }

      const fileBase = basename(task.musicInfo)
      const fileName = fileBase + '.' + ext
      stage = '导出音频至共享文件夹'
      const files = await readDir(currentFolder)
      if (!taskLive(task)) return
      if (!files.some(file => file.name === fileName)) {
        await moveFile(tmp, currentFolder + '/' + fileName)
      }
      if (!taskLive(task)) return
      task.fileName = fileName
      stage = '保存歌词'
      await saveLyrics(task, fileBase, currentFolder)
      if (!taskLive(task)) return
      task.progress = 100
      task.status = 'completed'
      task.error = ''
      emit()
      return
    }
    throw new Error('下载失败，音源链接可能失效')
  } catch (error: unknown) {
    if (!taskLive(task)) return
    task.status = 'failed'
    const message = error instanceof Error ? error.message : String(error)
    task.error = stage + '：' + message
    emit()
    // Audio and lyric retrieval are independent. A failed audio link should
    // not prevent saving a successfully resolved LRC file.
    if (task.options.saveLyric && task.lyricStatus !== 'saved') {
      await saveLyrics(task, basename(task.musicInfo), folder)
      emit()
    }
  } finally {
    jobs.delete(task.id)
    await unlink(tmp).catch(() => {})
    running.delete(task.id)
    pump()
  }
}

const pump = () => {
  if (!initialized) return
  while (running.size < MAX_CONCURRENT) {
    const next = tasks.find(t => t.status === 'waiting' && !running.has(t.id))
    if (!next) break
    next.status = 'running'
    running.add(next.id)
    emit()
    void downloadOne(next)
  }
}
