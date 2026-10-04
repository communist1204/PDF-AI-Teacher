# CosyVoice 3 本机试听

本机安装的是 `Fun-CosyVoice3-0.5B-2512`，由 RTX 5080 运行。无需语音 API Key，也不消耗云端字数包。首次朗读需要加载模型，之后本软件保持模型可用，退出软件时释放。它占用本机显存、计算和磁盘，并非所有电脑都能达到相同速度。

## 如何试听

1. 双击原来的 PDF AI Teacher 图标。
2. 设置与用量 → 朗读方式 → **CosyVoice 3（本机 GPU · 无 API 费用）** → 保存设置 → 应用并重启。
3. 在「CosyVoice 中文音色」选择原示例音色、中文女声 1／2、中文男声 1／2／3，点「试听这个音色」。每个音色用同一段文字试听，打开设置或切换下拉框不会自动出声。正式选择后点「保存设置」→「应用并重启」。
4. 打开 PDF、选中一两段正文，点「朗读所选」。保持 1× 先听声音；之后可在播放器原位切换 0.25–3×。

默认跳过本机检测到的公式，不自动调用 GPT 识别。纯扫描页、乱码文本不保证能读；保留主动校对入口。提供 6 个固定参考音色，不开放任意上传声音。新增 5 个来自 AISHELL-3 公开 TTS 数据集，不称为官方热门排行榜。试听借用统一音频输出，会停下当前声音并保留原文续读位置；停止试听或关闭设置即停播，不取消正在推理的文字问答。界面状态会区分安装、加载和可用，不把文件已下载当成模型已经运行。

首音需区分模型首次加载、生成第一块音频、播放器开始播放和实际音频中的静音。测量及限制见 [本机合成记录](cosy-runtime-verification.json) 和 [桌面播放记录](cosy-desktop-verification.json)。没有经过用户盲听，不能据此断言优于豆包或 OpenAI。高倍速可能比实时生成更快；缓存后的重播不需要重新合成。

## 复现安装

此电脑已安装完成，无需重复下载。下列命令供重建项目环境使用：

```powershell
cd D:\PDF-AI-Teacher
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-cosy-tts.ps1
py -3.11 -u scripts/verify-cosy-runtime.py
py -3.11 scripts/test-cosy-voices.py
py -3.11 -u scripts/verify-cosy-voices.py
npm run desktop:package
node scripts/verify-desktop-cosy.mjs
```

需要已有 Python 3.11、支持 CUDA 12.8 的 NVIDIA 驱动和足够磁盘/显存。安装脚本不安装驱动、不改 Conda/CUDA/系统代理；只在项目的 `cosy-tts-runtime` 建立虚拟环境，下载公开模型约 5.43 GB，以及 PyTorch 与推理依赖。网络下载与安装不是每次启动都执行。语音运行时强制使用已下载文件，不继承 API Key。

已有模型时，只修复新增参考文件可运行 `py -3.11 scripts/setup-cosy-voices.py`，约下载 2.37 MB，无需重装模型。本机 Web 开发可在私有 `.env` 设 `TTS_ENGINE=cosy`、`COSY_TTS_VOICE=cosy_female_1` 后执行 `npm run dev`；桌面使用设置页。权重与环境不嵌入 EXE，软件仍需保留当前项目目录中的 `cosy-tts-runtime`，不能只把 EXE 单独拷走。

## 固定来源与兼容修改

- [CosyVoice 官方源码](https://github.com/QwenAudio/CosyVoice/tree/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc)，固定 commit `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`。
- [官方 0.5B 模型](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/29e01c4e8d000f4bcd70751be16fa94bf3d85a18)，固定 revision `29e01c4e8d000f4bcd70751be16fa94bf3d85a18`；大型文件校验 SHA-256。
- Matcha 子模块固定 `dd9105b34bf2be2230f4aa1e4769fb586a3c824e`。模型代码与权重许可请查看各仓库；本应用的参考声音只标为官方演示参考，不宣称拥有该声音的商业授权。
- Python 3.11、PyTorch/torchaudio `2.8.0+cu128`、fp16；没有 TensorRT、vLLM 或 DeepSpeed。完整依赖快照在 `scripts/cosy-requirements-lock.txt`。
- ONNX CPU 用于启动时编码默认参考声音，新增声音首次使用时按需编码并缓存；切换不重新加载 GPU 模型，缓存后合成由 GPU 执行。没有把整个 TTS 静默退到 CPU。
- 应用 worker 每次恢复上游流式首块大小，增加取消/线程失败处理；第三方源码不直接修改。模型异常不继续复用可能污染的进程，下一次手动请求可重建。
- MP3 在生成中流式编码、播放；同一播放器原位调速。下一句在当前流完整生成后准备，不与当前生成争用会话；只缓存完整成功音频。

本机试音文件在 `cosy-tts-runtime/verification/`；该目录不进入 Git。主观听感、多音字与真实教材中的语义发音仍由用户试听确认。

## 新增参考声音来源

[AISHELL-3 官方发布页](https://openslr.org/93/)和[Interspeech 2021 原始论文](https://www.isca-archive.org/interspeech_2021/shi21c_interspeech.pdf)声明数据集采用 Apache-2.0、用于多说话人 TTS。本项目选择 5 个成年匿名说话人的完整普通话录音，原始音频不裁剪、不改速，文本仅加句末标点；原文来自 `train/content.txt`，性别/年龄组来自 `spk-info.txt`。固定镜像版本为 [AISHELL/AISHELL-3 f20d5db4](https://huggingface.co/datasets/AISHELL/AISHELL-3/tree/f20d5db4a31fe779ef07bb1af4ea92da5c786622)，原文件路径、文本、SHA-256 记录在 `assets/cosy-voices.json`，许可证及来源随程序 assets 和 runtime/voices 保留。

默认音色继续用官方 CosyVoice 演示参考；上游对部分示例有学术展示及互联网来源声明，不把它宣传为另行获得商业声音授权。这里没有模仿名人或宣传主播背书。

同一段长文本六音色的真实 GPU 数据见 [多音色测试记录](cosy-voices-verification.json)。六套音频均已生成，尚未做人耳盲听评分，不能据此承诺比豆包或 OpenAI 更自然。
