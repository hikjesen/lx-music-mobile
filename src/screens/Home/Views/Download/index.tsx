import { useEffect, useState } from 'react'
import { Alert, FlatList, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import {
  initializeDownloads,
  subscribeDownloads,
  getDownloadTasks,
  getDownloadFolder,
  chooseDownloadFolder,
  pauseDownload,
  resumeDownload,
  removeDownload,
  type DownloadTask,
} from '@/core/download/manager'

const labels: Record<DownloadTask['status'], string> = {
  waiting: '等待下载',
  running: '下载中',
  paused: '已暂停',
  failed: '失败',
  completed: '已完成',
}
const lyricLabels: Record<DownloadTask['lyricStatus'], string> = {
  pending: '歌词待下载',
  saved: 'LRC 已保存',
  missing: '歌词缺失',
  disabled: '未启用歌词下载',
}

export default () => {
  const theme = useTheme()
  const [tasks, setTasks] = useState<DownloadTask[]>(getDownloadTasks())
  const [folder, setFolder] = useState(getDownloadFolder())
  useEffect(() => {
    const refresh = () => {
      setTasks(getDownloadTasks())
      setFolder(getDownloadFolder())
    }
    const unsubscribe = subscribeDownloads(refresh)
    void initializeDownloads().then(refresh).catch(error => Alert.alert('下载初始化失败', String(error)))
    return unsubscribe
  }, [])

  const pickFolder = async() => {
    try {
      await chooseDownloadFolder()
      setFolder(getDownloadFolder())
    } catch (err: any) {
      Alert.alert('选择下载目录', err?.message || String(err))
    }
  }
  const remove = (task: DownloadTask) => {
    Alert.alert('移除下载任务', task.musicInfo.name, [
      { text: '取消', style: 'cancel' },
      { text: '移除', style: 'destructive', onPress: () => removeDownload(task.id) },
    ])
  }

  const renderItem = ({ item }: { item: DownloadTask }) => (
    <View style={{ ...styles.row, borderBottomColor: theme['c-border-background'] }}>
      <Text size={15} style={styles.title}>{item.musicInfo.name}</Text>
      <Text size={12} style={styles.detail}>{item.musicInfo.singer} · {item.quality} · {labels[item.status]}</Text>
      <Text size={12} style={styles.detail}>
        {item.status === 'running' ? item.progress + '% · ' : ''}{lyricLabels[item.lyricStatus]}
      </Text>
      {item.sourceDetail ? <Text style={styles.detail} size={12}>{item.sourceDetail}</Text> : null}
      {item.error ? <Text style={styles.error} size={12}>{item.error}</Text> : null}
      {item.fileName ? <Text style={styles.detail} size={12}>{item.fileName}</Text> : null}
      <View style={styles.buttons}>
        {item.status === 'waiting' || item.status === 'running'
          ? <TouchableOpacity style={styles.action} onPress={() => pauseDownload(item.id)}><Text>暂停</Text></TouchableOpacity>
          : item.status === 'paused' || item.status === 'failed'
            ? <TouchableOpacity style={styles.action} onPress={() => resumeDownload(item.id)}><Text>重试 / 继续</Text></TouchableOpacity>
            : null}
        <TouchableOpacity style={styles.action} onPress={() => remove(item)}><Text>移除</Text></TouchableOpacity>
      </View>
    </View>
  )

  return (
    <View style={styles.container}>
      <TouchableOpacity style={{ ...styles.folder, borderBottomColor: theme['c-border-background'] }} onPress={() => { void pickFolder() }}>
        <Text size={15}>选择歌曲保存目录</Text>
        <Text size={12} style={styles.folderLabel}>{folder || '尚未选择。首次下载会自动询问。'}</Text>
      </TouchableOpacity>
      <FlatList
        data={tasks}
        extraData={tasks}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        ListEmptyComponent={<Text style={styles.empty}>暂无下载任务。可在歌曲菜单中选择「下载」。</Text>}
      />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  folder: { padding: 15, borderBottomWidth: 1 },
  folderLabel: { opacity: 0.7, marginTop: 8 },
  row: { padding: 14, borderBottomWidth: 1 },
  title: { marginBottom: 5 },
  detail: { opacity: 0.75, marginTop: 3 },
  error: { marginTop: 5, color: '#d45454' },
  buttons: { flexDirection: 'row', marginTop: 10 },
  action: { paddingVertical: 8, paddingRight: 22 },
  empty: { padding: 24, opacity: 0.75 },
})
