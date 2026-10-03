自制测试 PDF 由 scripts/create-fixtures.mjs 使用本机 Edge 生成，位于 public/sample.pdf。内容可自由分发，无商业教材。
# 流式播放器测试音频

`cosy-stream.mp3` 是本项目生成的 20 秒低幅 440 Hz 正弦波，不含人声，不是模型生成效果或真人试听证据。它用于检查 MP3 MediaSource 在 HTTP 响应尚未结束时能否开播，以及暂停、调速、取消、断连和句间切换。

生成命令（FFmpeg 7.1）：

```text
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=24000:duration=20 -af volume=0.01 -ac 1 -codec:a libmp3lame -b:a 64k -write_xing 0 -id3v2_version 0 cosy-stream.mp3
```
