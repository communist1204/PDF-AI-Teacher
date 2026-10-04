# CosyVoice 3 本机参考音色试听

本机用 `Fun-CosyVoice3-0.5B-2512` 和 RTX 5080 生成朗读，无需语音 API Key，不消耗云端字数包。用户从官方目录选中的六个参数对应的是云端音色；这里用它们的公开试听片段作参考，让开源模型近似生成，**不等同于获得云端原版，也不保证完全相同的音质**。

## 现在怎么听

1. 双击原来的 PDF AI Teacher 图标，点「声音设置」。
2. 「朗读方式」选 CosyVoice 3（本机 GPU），在「CosyVoice 中文音色」选择一个声音，点「试听这个音色」。
3. 六个声音朗读同一段专业学习文本；切换下拉框会停止旧声音，点试听才生成新声音。选择喜欢的声音后点「保存设置」→「应用并重启」。
4. 在 PDF 选中正文，点「朗读所选」。先以 1× 判断听感，再在播放器原位调节 0.25–3×。

|本地选项|你指定的云端参数|本地配置 ID|
|---|---|---|
|龙安洋 · 本地参考|`longanyang`|`local_longanyang`|
|龙安欢 · 本地参考|`longanhuan_v3`|`local_longanhuan_v3`|
|龙飞 · 本地参考|`longfei_v3`|`local_longfei_v3`|
|龙小淳 · 本地参考|`longxiaochun_v3`|`local_longxiaochun_v3`|
|龙小夏 · 本地参考|`longxiaoxia_v3`|`local_longxiaoxia_v3`|
|龙安昀 · 本地参考|`longanyun_v3`|`local_longanyun_v3`|

旧示例/AISHELL 音色已移除。声音设置提供关闭、本机 CosyVoice、豆包语音 2.0；豆包使用独立 API Key，主动朗读时才发送正文至火山引擎。原解题账号、专业模型及已存凭证保留。旧本机音色迁移为龙安洋本地参考，关闭朗读及已存豆包的偏好均保留。六个本机参考音色的限制只针对 CosyVoice 音色列表。

默认跳过本机检测到的公式，不自动调用 GPT 识别。纯扫描页、乱码提取不保证可朗读，仍可主动校对。试听与读书共享一个音频输出，会保留原文续读位置；关设置或停止试听即可停播，不取消后台文字问答。

## 速度和验证边界

本机六种新参考、同一 169 字段落的实测：模型首次就绪约 19 秒；就绪后首块 MP3 约 1.41–2.40 秒，含首次编码参考的耗时。播放器会先攒约2秒可播放音频再开播，因此点击到听到声音还包含这段准备；短句生成完即可播放。回切已用音色无需再编码或加载模型。音频在生成中流式播放。机器负载、文本与高倍速都会影响等待，不能承诺任何场景零卡顿。

参见 [六音色 GPU 数据](cosy-local-references-verification.json) 和 [桌面试听数据](cosy-local-references-desktop-verification.json)。这些记录验证真实合成与播放器，不替代人耳评价。龙飞的长段测试出现疑似漏词，已在选项说明中提示核对。自然度、声线相似度、多音字及教材中的语义发音仍由用户确认，未宣称优于豆包或 OpenAI。

## 复现安装

此电脑已准备好，不需要重复安装。重建环境时：

```powershell
cd D:\PDF-AI-Teacher
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-cosy-tts.ps1
py -3.11 scripts/setup-cosy-voices.py
py -3.11 scripts/test-cosy-voices.py
py -3.11 scripts/verify-cosy-voices.py
py -3.11 scripts/verify-cosy-runtime.py --cancel-only
npm run desktop:package
node scripts/verify-desktop-cosy-voices.mjs
```

已有模型时，只补参考声音运行 `py -3.11 scripts/setup-cosy-voices.py`。脚本下载六份固定官方 MP3，验证源文件 SHA-256，再用固定运行时 ffmpeg 解码为完整单声道 24kHz PCM WAV，验证输出哈希；不硬切、不变速。所有文件确认通过才更新清单并删除旧安装器生成的五个 WAV。

需要已有 Python 3.11、支持 CUDA 12.8 的 NVIDIA 驱动和足够磁盘/显存。脚本仅在项目 `cosy-tts-runtime` 建立环境，下载公开权重约 5.43 GB 及局部依赖，不安装驱动、不改 Conda/CUDA/系统代理。权重和参考音频不打入 EXE，保留当前项目目录的运行时即可；不能只拷走 EXE。

Web 开发模式可在私有 `.env` 设 `TTS_ENGINE=cosy`、`COSY_TTS_VOICE=local_longanyang`，执行 `npm run dev`。桌面用声音设置，无需手改文件。

## 来源与实现

- [CosyVoice 官方源码](https://github.com/QwenAudio/CosyVoice/tree/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc)，固定 commit `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`。
- [官方 0.5B 模型](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/29e01c4e8d000f4bcd70751be16fa94bf3d85a18)，固定 revision `29e01c4e8d000f4bcd70751be16fa94bf3d85a18`。Matcha 固定 `dd9105b34bf2be2230f4aa1e4769fb586a3c824e`。
- Python 3.11、PyTorch/torchaudio `2.8.0+cu128`、fp16；不依赖 TensorRT、vLLM、DeepSpeed。依赖快照为 `scripts/cosy-requirements-lock.txt`。
- [阿里云官方音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)提供用户所选六个试听片段。固定 URL、源/解码哈希见 `assets/cosy-voices.json`；来源说明为 `assets/COSY-REFERENCE-NOTICE.txt`。公开试听不代表获得声音商业再分发授权，模型许可不自动覆盖这些音频。参考音频不进入 Git 或发布包。
- 按官方 `inference_cross_lingual` 示例，以声学参考和说话人特征合成中文，不把参考识别结果写成提示文本。准备阶段尝试的本机 ASR 有错字，因此最终不依赖它。日常读 PDF 不多一道识别等待，也不发送文本到云 TTS。
- ONNX CPU 仅用于每个声音首次使用的参考编码，编码结果缓存在同一模型中；正文合成由 GPU 执行。切声音不加载第二个模型。
- 流式 MP3、原位变速、取消、单一音源和 EOF 后准备下一句保持。未知/损坏的声音会报错，不暗中换成另一声线。

生成的试听文件在 `cosy-tts-runtime/verification/local-references/`，被 Git 忽略。选择一个真正合你耳朵的声音后，再用你的教材连续试听。
