package cn.toside.music.mobile.utils;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Small Android-only streaming downloader for the personal LX MVP.
 * Keeps audio bytes out of the JavaScript heap and uses an already registered
 * React Native native module. Only writes into this app's private files area.
 */
final class AudioDownloadHelper {
  private static final String PROGRESS_EVENT = "lx-download-progress";
  private static final int IO_BUFFER_SIZE = 32 * 1024;
  private final ReactApplicationContext context;
  private final UtilsEvent events;
  private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<>();

  static final class Job {
    final AtomicBoolean canceled = new AtomicBoolean(false);
    volatile HttpURLConnection connection;
  }

  AudioDownloadHelper(ReactApplicationContext context, UtilsEvent events) {
    this.context = context;
    this.events = events;
  }

  void cancel(String id) {
    final Job job = jobs.get(id);
    if (job != null) {
      job.canceled.set(true);
      final HttpURLConnection connection = job.connection;
      if (connection != null) connection.disconnect();
    }
  }

  void start(String id, String url, String destPath, ReadableMap headers, Promise promise) {
    if (id == null || id.isEmpty()) {
      promise.reject("DOWNLOAD_ID", "Download job id is missing");
      return;
    }
    final Job job = new Job();
    if (jobs.putIfAbsent(id, job) != null) {
      promise.reject("DOWNLOAD_BUSY", "This download is already running");
      return;
    }

    Thread thread = new Thread(() -> {
      File output = null;
      HttpURLConnection connection = null;
      try {
        URL parsedUrl = new URL(url);
        if (!"http".equals(parsedUrl.getProtocol()) && !"https".equals(parsedUrl.getProtocol())) {
          throw new IOException("Only HTTP/HTTPS audio URLs are supported");
        }

        File root = context.getFilesDir().getCanonicalFile();
        output = new File(destPath).getCanonicalFile();
        if (!output.getPath().startsWith(root.getPath() + File.separator)) {
          throw new IOException("The temporary download must stay in the app's private files directory");
        }
        File parent = output.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) {
          throw new IOException("Cannot create temporary download directory");
        }

        connection = (HttpURLConnection) parsedUrl.openConnection();
        job.connection = connection;
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(25000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("User-Agent",
          "Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36");

        if (headers != null) {
          ReadableMapKeySetIterator iterator = headers.keySetIterator();
          while (iterator.hasNextKey()) {
            String key = iterator.nextKey();
            String value = headers.getString(key);
            if (value != null && !key.equalsIgnoreCase("host")) connection.setRequestProperty(key, value);
          }
        }
        connection.connect();
        int statusCode = connection.getResponseCode();
        if (statusCode != 200 && statusCode != 206) {
          throw new IOException("Audio HTTP status " + statusCode);
        }

        long expectedLength = connection.getContentLengthLong();
        long written = 0;
        long lastProgressMs = 0;
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             BufferedOutputStream outputStream = new BufferedOutputStream(new FileOutputStream(output))) {
          byte[] buffer = new byte[IO_BUFFER_SIZE];
          int read;
          while ((read = input.read(buffer)) != -1) {
            if (job.canceled.get()) throw new IOException("Download canceled");
            outputStream.write(buffer, 0, read);
            written += read;
            long now = System.currentTimeMillis();
            if (now - lastProgressMs >= 400) {
              sendProgress(id, written, expectedLength);
              lastProgressMs = now;
            }
          }
        }

        if (job.canceled.get()) throw new IOException("Download canceled");
        if (written < 1024) throw new IOException("Audio file is too small");
        if (expectedLength > 0 && written < expectedLength) {
          throw new IOException("Download incomplete: received " + written + " of " + expectedLength + " bytes");
        }
        String extension = sniffFileType(output);
        sendProgress(id, written, expectedLength);
        WritableMap result = Arguments.createMap();
        result.putInt("statusCode", statusCode);
        result.putDouble("bytesWritten", (double) written);
        result.putString("extension", extension);
        promise.resolve(result);
      } catch (Exception error) {
        if (output != null && output.exists()) {
          // The incomplete file may be retried by the JavaScript queue.
          output.delete();
        }
        promise.reject(job.canceled.get() ? "DOWNLOAD_CANCELED" : "AUDIO_DOWNLOAD_FAILED",
          error.getMessage() != null ? error.getMessage() : error.toString(), error);
      } finally {
        if (connection != null) connection.disconnect();
        jobs.remove(id, job);
      }
    }, "lx-audio-" + Integer.toHexString(id.hashCode()));
    thread.start();
  }

  private void sendProgress(String id, long received, long total) {
    WritableMap data = Arguments.createMap();
    data.putString("id", id);
    data.putDouble("bytesWritten", received);
    data.putDouble("contentLength", total);
    events.sendEvent(PROGRESS_EVENT, data);
  }

  private static String sniffFileType(File file) throws IOException {
    byte[] head = new byte[32];
    int len;
    try (FileInputStream input = new FileInputStream(file)) {
      len = input.read(head);
    }
    if (len < 12) throw new IOException("Audio header is too short");

    if (head[0] == 'f' && head[1] == 'L' && head[2] == 'a' && head[3] == 'C') return "flac";
    if (head[0] == 'O' && head[1] == 'g' && head[2] == 'g' && head[3] == 'S') return "ogg";
    if (head[0] == 'M' && head[1] == 'A' && head[2] == 'C' && head[3] == ' ') return "ape";
    if (head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F') return "wav";
    if (head[0] == 'I' && head[1] == 'D' && head[2] == '3') return "mp3";
    if ((head[0] & 255) == 255 && ((head[1] & 255) & 224) == 224) return "mp3";
    if (head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p') return "m4a";

    throw new IOException("Audio format was not recognized; the server may have returned HTML, a playlist, or an unsupported file");
  }
}
