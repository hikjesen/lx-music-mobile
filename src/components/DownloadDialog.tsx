import { forwardRef, useImperativeHandle, useState } from 'react'
import { Alert, Modal, ScrollView, Switch, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { queueDownloads, type DownloadQuality, type DownloadOptions } from '@/core/download/manager'

export interface DownloadDialogType {
  show: (music: LX.Music.MusicInfoOnline[]) => void
}

const qualities: Array<{ id: DownloadQuality, label: string }> = [
  { id: '128k', label: 'MP3 128K' },
  { id: '320k', label: 'MP3 320K' },
  { id: 'flac', label: 'FLAC 无损' },
  { id: 'flac24bit', label: 'FLAC Hi-Res' },
]

export default forwardRef<DownloadDialogType, {}>((_, ref) => {
  const [visible, setVisible] = useState(false)
  const [songs, setSongs] = useState<LX.Music.MusicInfoOnline[]>([])
  const [busy, setBusy] = useState(false)
  const [options, setOptions] = useState<DownloadOptions>({ saveLyric: true, translation: true, romanization: false })
  const theme = useTheme()

  useImperativeHandle(ref, () => ({
    show(music) {
      setSongs(music.filter(info => info.source !== 'local'))
      setVisible(true)
    },
  }))

  const updateOption = (key: keyof DownloadOptions, value: boolean) => {
    setOptions(prev => ({ ...prev, [key]: value }))
  }
  const start = async(quality: DownloadQuality) => {
    if (busy) return
    setBusy(true)
    // The system folder chooser opens a native Activity; dismiss RN's modal first.
    setVisible(false)
    try {
      const count = await queueDownloads(songs, quality, options)
      toast('已加入 ' + count + ' 首歌曲到下载队列')
    } catch (err: unknown) {
      Alert.alert('下载任务创建失败', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { setVisible(false) }}>
      <View style={styles.backdrop}>
        <View style={{ ...styles.panel, backgroundColor: theme['c-content-background'] }}>
          <Text style={styles.heading} size={18}>下载歌曲（{songs.length} 首）</Text>
          <Text style={styles.subheading}>请选择目标音质。首次下载会要求选择保存文件夹。</Text>
          <ScrollView>
            {qualities.map(q => (
              <TouchableOpacity key={q.id} style={{ ...styles.quality, borderColor: theme['c-border-background'] }} disabled={busy} onPress={() => { void start(q.id) }}>
                <Text size={16}>{q.label}</Text>
              </TouchableOpacity>
            ))}
            <View style={styles.option}>
              <Text>同时保存 LRC 歌词</Text>
              <Switch value={options.saveLyric} onValueChange={v => { updateOption('saveLyric', v) }} />
            </View>
            <View style={styles.option}>
              <Text>包含翻译歌词</Text>
              <Switch value={options.translation} disabled={!options.saveLyric} onValueChange={v => { updateOption('translation', v) }} />
            </View>
            <View style={styles.option}>
              <Text>包含罗马音</Text>
              <Switch value={options.romanization} disabled={!options.saveLyric} onValueChange={v => { updateOption('romanization', v) }} />
            </View>
          </ScrollView>
          <TouchableOpacity onPress={() => { setVisible(false) }} style={styles.cancel}>
            <Text>取消</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
})

const styles = createStyle({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 22,
  },
  panel: {
    borderRadius: 12,
    padding: 18,
    maxHeight: '85%',
  },
  heading: {
    marginBottom: 8,
  },
  subheading: {
    marginBottom: 14,
    opacity: 0.75,
    fontSize: 12,
  },
  quality: {
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 7,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  cancel: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 3,
  },
})
