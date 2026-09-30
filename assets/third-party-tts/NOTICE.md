# Local Chinese TTS: third-party notices

This local application optionally includes Kokoro-82M-v1.1-zh and sherpa-onnx 1.13.8 for CPU-only speech. The speech module is not an OpenAI service. These voices are AI-generated, not a live human reader.

- Kokoro-82M-v1.1-zh model: Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh . The original model package LICENSE is retained in the model directory.
- sherpa-onnx: Apache-2.0, https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8 . See LICENSE-sherpa-onnx.txt.
- ONNX Runtime: MIT, https://github.com/microsoft/onnxruntime . See LICENSE-onnxruntime.txt. Binary source/version is the one included in the pinned sherpa-onnx-win-x64 npm distribution.
- eSpeak NG, used through the phonemizer and its language data: GPL-3.0-or-later, https://github.com/espeak-ng/espeak-ng . See COPYING-espeak-ng.txt. sherpa maintainer's dependency note: https://github.com/k2-fsa/sherpa-onnx/issues/3731 .

The complete bundle is not represented as Apache-only. This project is currently delivered for the owner's local use. Public redistribution must retain notices and meet the applicable source/distribution obligations, including GPL components. Do not infer proprietary redistribution compatibility from the model's Apache license alone.

Public, pinned model archive:
https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2
Size: 364816464 bytes
SHA256: a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad
