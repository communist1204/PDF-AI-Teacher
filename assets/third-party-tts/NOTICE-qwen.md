# Qwen native speech build notices

The optional Qwen voice uses Alibaba Qwen3-TTS-12Hz-1.7B-CustomVoice through the community C++ implementation below. The C++ runtime is not an official Alibaba binary. Free local synthesis does not imply a tested subjective improvement over other speech systems.

- Model: Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice and Qwen3-TTS-Tokenizer-12Hz, Apache-2.0. https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- Converted models: https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF revision b7ee2e8c7459c3bea99da23e3d178125a7d1713c. Original model license is retained.
- qwentts.cpp: https://github.com/ServeurpersoCom/qwentts.cpp commit 6fae92914045cd83364d2845ceaa0f7969727319, MIT (LICENSE-qwentts-cpp.txt).
- GGML fork: https://github.com/ServeurpersoCom/ggml commit 40e16e4a814f7fe851a0c486fb9e8c722e957830, MIT (LICENSE-qwen-ggml.txt).
- Vendored HTTP and JSON dependencies carry MIT notices in LICENSE-cpp-httplib.txt and LICENSE-yyjson.txt. The application currently builds and calls only the local CLI, not its HTTP server.

The project-owned scripts/qwen-tts-native.patch changes the default worker count from a hardware-wide heuristic to two threads (only the child-process environment PDF_AI_TTS_THREADS=4 selects four). It also writes PDF_AI_TTS_FRAME_LIMIT_REACHED to stderr when generation hits the configured audio-frame cap, allowing the application to reject an incomplete reading. No model weights are modified.

Build recipe: node scripts/build-qwen-tts.mjs, using an existing Windows Visual Studio C++ toolchain. PDF_AI_VS_ROOT may identify that existing installation. No tools are installed globally. All GPU backends, BLAS, OpenMP, and dynamic backend loading are disabled. MSVC runtime and GGML are statically linked. GGML_NATIVE is enabled, so this artifact is for the build machine's CPU capabilities; rebuild on a different machine rather than assuming general Windows portability.

Pinned model files:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| qwen-talker-1.7b-customvoice-Q4_K_M.gguf | 1182631296 | cc328834a631bc08bf9f43e62fa23f8a1383d9b429864ce6690cfb172077fc4a |
| qwen-tokenizer-12hz-Q8_0.gguf | 291150624 | 1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94 |

The build script performs a native C ABI probe but does not generate audio, read private settings, or test listening quality. Real synthesis, elapsed time, cancellation, and user listening must be recorded separately.

Windows CLI correction: scripts/qwen-tts-windows-utf8.patch calls the upstream utf8_init before parsing command-line arguments. Both CPU and CUDA builds include it, preserving Chinese style instructions.

Optional CUDA recipe: node scripts/build-qwen-tts-cuda.mjs uses the already-installed CUDA 12.9 and builds for NVIDIA SM120a (RTX 5080), with static cudart, MSVC and GGML plus CUDA graphs. It copies only the required cuBLAS redistributable DLLs into qwen-tts-runtime/bin-cuda alongside the executable; each hash is recorded in manifest.json. The unmodified NVIDIA CUDA EULA is distributed in bin-cuda/LICENSE-NVIDIA-CUDA.txt. CUDA redistributables remain under NVIDIA terms, not this project’s MIT/Apache licenses. No driver/toolkit installation or global PATH edits are performed. Other GPU architectures require a separate build and actual verification.
