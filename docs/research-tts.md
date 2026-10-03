# 科研语音候选与本地复现路线

核验日期：2026-10-03。目标：中文 PDF 正文自然朗读、较短首音等待、长文连续、原位变速；公式继续跳过。此次是资料核验与复现方案准备，没有安装新模型或测试真实声音。

## 结论

确有顶会发表且开放代码/权重的路线：F5-TTS（ACL 2025）和 IndexTTS2（AAAI 2026）。科研成果可以用于本产品，但会议级别、开源关注度、作者样音不能替代本机长文验收。首轮工程验证优先 CosyVoice 3；dots.tts 为前沿流式对照；IndexTTS-2.5 用于自然度对照，F5-TTS 为成熟科研基线。这是基于能力与部署约束的选型推断，尚非实听排名。

## 四个重点候选

|候选及固定模型名|科研与开放依据|与需求的匹配|主要边界|
|---|---|---|---|
|CosyVoice 3：Fun-CosyVoice3-0.5B-2512|官方技术报告；代码、对应权重 Apache-2.0|中文、文本归一化、参考音色、原生分块音频输出；优先试|主论文不能写成已收录顶会；公开0.5B不等同论文1.5B；默认旧PyTorch依赖不能直接套5080|
|dots.tts：dots.tts-mf／dots.tts-mf-2steps-stts|2026技术报告；推理/训练代码和权重 Apache-2.0|真正音频流式，后者支持文本与声音双流；较新的对照|2B；优化路径有编译预热；速度来自H800而非本机；不称已发表顶会|
|IndexTTS-2.5|前代IndexTTS2为AAAI2026；2.5为后继技术报告；公开代码/权重|情感与音色控制，中文发音可干预，模型卡约6GB显存|自定义bilibili许可证；长文分段拼接且韵律不跨段建模；不能承诺自然衔接|
|F5-TTS v1 Base|ACL2025主会长文；MIT代码，CC-BY-NC-4.0权重|成熟复现基线、中英混读、开放训练流程|默认推理子段完整生成后再输出，数字仍需前处理；不是首音优先的第一选择|

### 学术、源码与试听依据

- CosyVoice：[官方仓库](https://github.com/QwenAudio/CosyVoice)、[0.5B权重](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)、[主论文](https://arxiv.org/abs/2505.17589)、[官方试听Space](https://huggingface.co/spaces/FunAudioLLM/Fun-CosyVoice3-0.5B)。仓库由 FunAudioLLM 重定向 QwenAudio；它与已经淘汰的 Qwen3-TTS 是不同项目，不因组织名相近就视作相同模型。另有 [ICASSP 2025系统论文](https://ieeexplore.ieee.org/document/10890358)，不能把它冒充CosyVoice3主论文录用证明。
- dots.tts：[官方仓库](https://github.com/studio-dots-ai/dots.tts)、[2026技术报告](https://arxiv.org/abs/2606.07080)、[双流权重与API示例](https://huggingface.co/dots-studio/dots.tts-mf-2steps-stts)。论文、仓库的不同推理配置不可混合比较；SGLang Omni的按句WebSocket服务也不能当成同一请求逐token双流。
- IndexTTS：[AAAI2026会录](https://ojs.aaai.org/index.php/AAAI/article/view/40820)、[2.5技术报告](https://arxiv.org/abs/2601.03888)、[源码](https://github.com/index-tts/index-tts)、[2.5模型卡](https://huggingface.co/IndexTeam/IndexTTS-2.5)、[作者样音](https://index-tts.github.io/index-tts2-5.github.io/)。AAAI论文对应2.0，不能把2.5标为已在AAAI发表。
- F5：[ACL2025会录](https://aclanthology.org/2025.acl-long.313/)、[源码](https://github.com/SWivid/F5-TTS)、[权重及许可](https://huggingface.co/SWivid/F5-TTS)、[作者样音](https://swivid.github.io/F5-TTS/)。官方推理代码的 infer_single_process_streaming 先完成 _infer_basic，再切波形输出；这条路径的名字不是原生增量声学生成的证据。

## 速度和可复现不能省略的条件

|项目|官方有明确环境的报告|不能推导的结论|
|---|---|---|
|CosyVoice3|单L20、TensorRT-LLM、4并发，首块均值约750ms、P95约978ms；[部署说明](https://github.com/QwenAudio/CosyVoice/blob/main/runtime/triton_trtllm/README.Cosyvoice3.md)|不能借用CosyVoice2或README未注明硬件的150ms作为5080成绩|
|dots.tts-mf|H800、优化预热后，克隆路径首块p50约204ms、峰值分配约5.74GB；优化首次编译约3分钟；[仓库基准](https://github.com/studio-dots-ai/dots.tts#-efficiency)|不是用户点击到首个非静音音节的时间，不是Windows5080实测|
|F5-TTS|官方L20、16NFE下PyTorch RTF约0.1467；[基准](https://github.com/SWivid/F5-TTS)|RTF是生成用时/音频时长，不是首音时延|
|Faster IndexTTS-2|独立加速实现提供真实音频分块；[官方部署](https://github.com/index-tts/index-tts/blob/main/backends/trt/README.md)验证4090 24GB、Linux/TensorRT-LLM/OpenMPI|仅支持2.0，不可说2.5已具备相同TensorRT流式路径|

本机只读查询得到 NVIDIA RTX5080、16303MiB显存，查询瞬间使用2269MiB；不是稳定空闲保证。16GB给小型模型试验提供容量基础，但Windows、Blackwell兼容性、算子与持续速度均待实际验证。复现使用项目独立环境与明确版本，不修改现有Conda/CUDA、驱动、代理或训练进程。

“可复现”分两层：开放权重和推理代码可复测实际生成；完整重训还需要相同数据、训练配方、计算量与组件。CosyVoice论文完整大规模训练语料未取得，不能称从零复现。作者公布的基准也不能直接当成本项目验收。

“用得多”方面，官方页面可见F5与Index有大量社区派生/下载，但这不等于工业部署数量。此次没有取得可信的全行业装机或生产使用排名。GitHub元数据API补查失败（WebException），未伪造精确实时计数或代码SHA；真正开始本地复现时仍须锁定commit、权重revision/hash和依赖锁文件。

## 其他看过但不作为首轮主选

- [Fish S2-Pro](https://huggingface.co/fishaudio/s2-pro)：4B，官方建议24GB与Linux/WSL，Research License；当前16GB原版部署不是优先。云端S2.1的限时免费活动不等于其权重开源或永久免费。
- [Breeze TTS2](https://github.com/breezeblue-ai/breeze-tts)：中英文、流式与语气控制值得试听；权重/自托管输出有研究非商业限制；官方低延迟为H100优化暖机结果，未确认Windows5080支持。
- [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)：0.1B，ONNX CPU/浏览器部署方便；有现成[本地网页朗读器](https://github.com/OpenMOSS/MOSS-TTS-Nano-Reader)。可作低资源备选，但没有证据说明声音达到用户已满意的Readest/豆包水平，本次也未核实顶会录用。

## 对接本软件的最小验证路线

1. 用官方授权参考音色试听中文；作者样音只筛听感，不能测本机首音。优先CosyVoice3，再对照Index2.5或dots.tts。
2. 在项目私有环境复现一个固定权重版本；记录依赖、模型与参考音hash，关闭不需要的训练/高并发组件。冷启动加载与暖机后首音分别测量。
3. 使用本机PDF文字抽取、跨行整理和公式过滤，直接把正文送TTS；不先等待大模型解释原文。所有候选收到相同净化文本，模型自身数字归一化另设原始文本对照。
4. 本机TTS作为按需启动、常驻到显式退出的子进程；只监听回环。输出PCM帧连同完成/错误状态，现有Node后端保留取消及speech envelope，前端扩展增量播放器。当前完整Blob路径不能伪装成流式接入。
5. 试听通过后再加设置入口。播放器保持单音源、按秒数的有界预备缓冲、原位保调变速和句锚点；不以缩短每个句子制造更多语气断裂。停止清空缓冲并拒绝迟到帧。

原创短测例见 [tts-research-cases.json](tts-research-cases.json)，长文复用 [readest-audition.txt](readest-audition.txt)。它们是待执行输入与观察标准，不是测试通过报告。至少比较冷启动/暖机的首个非静音声音、1×/2×/3×连续十分钟缓冲、漏增字、数字与多音字、声线一致、停止≤300ms目标。若要3×稳定播放，持续生成RTF需低于约1/3并留出处理余量；这仍不等同首音达标。

尚未完成：模型安装、实际合成、中文真人盲听、显存和延迟实测、产品设置与流式播放集成。本轮没有通过降低验收标准声称这些能力已交付。
