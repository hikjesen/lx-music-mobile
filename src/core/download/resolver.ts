import { getMusicUrl } from '@/core/music/online'
import playerState from '@/store/player/state'
import { getCurrentTrack, isTempTrack } from '@/plugins/player/playList'

import type { DownloadQuality } from './manager'

export interface DownloadUrlResult {
  url: string
  detail: string
  headers?: Record<string, string>
}

const looksLikeSameSong = (first: LX.Music.MusicInfoOnline, second: LX.Music.MusicInfoOnline) => {
  if (first.source === second.source && first.id === second.id) return true
  const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  return sameText(first.name, second.name) &&
    sameText(first.singer, second.singer) &&
    (!first.interval || !second.interval || first.interval === second.interval)
}

export const resolveDownloadUrl = async(
  musicInfo: LX.Music.MusicInfoOnline,
  quality: DownloadQuality,
  isRefresh: boolean,
): Promise<DownloadUrlResult> => {
  const current = playerState.playMusicInfo.musicInfo
  const activeSameSong = current != null && !('progress' in current) &&
    current.source !== 'local' && looksLikeSameSong(musicInfo, current)
  const activeMusic = activeSameSong ? current : null

  // Follow the actual playback logic: a previously chosen alternate source
  // may be the only source that can resolve this track.
  const preferred = musicInfo.meta.toggleMusicInfo ?? activeMusic?.meta.toggleMusicInfo
  const attempts: Array<{ music: LX.Music.MusicInfoOnline, requested: boolean, label: string }> = []
  const add = (music: LX.Music.MusicInfoOnline | undefined, requested: boolean, label: string) => {
    if (!music) { return }
    if (attempts.some(item => item.music.source === music.source && item.music.id === music.id && item.requested === requested)) return
    attempts.push({ music, requested, label })
  }

  add(preferred, true, '已选换源／指定音质')
  add(musicInfo, true, '原始来源／指定音质')
  add(preferred, false, '已选换源／自动音质')
  add(musicInfo, false, '原始来源／自动音质')

  const reasons: string[] = []
  for (const attempt of attempts) {
    try {
      const url = await getMusicUrl({
        musicInfo: attempt.music,
        quality: attempt.requested ? quality : undefined,
        isRefresh,
        allowToggleSource: false,
      })
      if (url && /^https?:\/\//i.test(url)) {
        return { url, detail: attempt.label }
      }
      reasons.push(attempt.label + '：无可用 HTTP 音频地址')
    } catch (err: unknown) {
      reasons.push(attempt.label + '：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // The currently playing TrackPlayer stream is an especially useful fallback
  // when the chosen third-party source can play a song but cannot resolve
  // an explicit download quality. Never use the placeholder track.
  if (activeSameSong) {
    try {
      const track = await getCurrentTrack()
      if (track && !isTempTrack(String(track.id)) &&
        /^https?:\/\//i.test(track.url) &&
        (track.musicId === activeMusic?.id || track.musicId === musicInfo.id) &&
        track.title?.trim().toLowerCase() === musicInfo.name.trim().toLowerCase()) {
        return {
          url: track.url,
          detail: '复用当前播放器的可用音频地址（实际音质以文件为准）',
          headers: track.userAgent ? { 'User-Agent': track.userAgent } : undefined,
        }
      }
    } catch (err: unknown) {
      reasons.push('当前播放器地址：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // Only after trying the exact source and the same playback candidates
  // ask LX to search other music services; forcing the requested quality here
  // would often skip otherwise playable matches.
  try {
    const url = await getMusicUrl({
      musicInfo,
      isRefresh,
      allowToggleSource: true,
    })
    if (url && /^https?:\/\//i.test(url)) {
      return { url, detail: 'LX 自动换源／自动音质' }
    }
  } catch (err: unknown) {
    reasons.push('自动换源：' + (err instanceof Error ? err.message : String(err)))
  }

  console.warn('Audio URL resolution failed', reasons)
  throw new Error('所有音源解析方式均失败；请先播放同一首歌曲再重试。详情：' + reasons.slice(-2).join('；'))
}
