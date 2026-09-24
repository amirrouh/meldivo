# Third-Party Notices

pi-meldivo is MIT-licensed, but it uses and can interoperate with software and
models under their own terms. This file identifies the material dependencies
and optional components known to this source release. It is not a replacement
for the complete license text supplied by each dependency.

## Speech runtime

Speech-to-text and text-to-speech run locally via
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`).

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE) — Apache-2.0

Model weights are downloaded on first use and cached under
`~/.cache/meldivo/models`; they are not committed to this repository.

Speech-to-text:

- [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) — CC-BY-4.0

Text-to-speech:

- [Kokoro v1.0](https://huggingface.co/hexgrad/Kokoro-82M) — Apache-2.0

## Included web runtime components

The web application uses voice-activity detection assets copied at build time
from `@ricky0123/vad-web`, which bundles Silero VAD and runs on ONNX Runtime
Web.

- [@ricky0123/vad-web](https://www.npmjs.com/package/@ricky0123/vad-web) — ISC
- [Silero VAD](https://github.com/snakers4/silero-vad/blob/master/LICENSE) — MIT
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) — MIT

## JavaScript and TypeScript dependencies

The exact dependency tree and resolved versions are recorded in
[`package-lock.json`](package-lock.json). License metadata and license files
are supplied by the respective npm packages. The main direct dependencies are:

- [Express](https://www.npmjs.com/package/express) — MIT
- [sherpa-onnx-node](https://www.npmjs.com/package/sherpa-onnx-node) — Apache-2.0
- [React](https://www.npmjs.com/package/react) and
  [React DOM](https://www.npmjs.com/package/react-dom) — MIT
- [TypeScript](https://www.npmjs.com/package/typescript) — Apache-2.0
- [Vite](https://www.npmjs.com/package/vite) — MIT
- [tsx](https://www.npmjs.com/package/tsx) — MIT

Transitive dependencies remain under their original licenses.

## External services and coding harnesses

pi-meldivo runs as an extension inside [Pi](https://pi.dev)
(`@earendil-works/pi-coding-agent`, a peer dependency, not bundled) and uses
that session's model, tools, and credentials. Those services and their terms
are selected and operated by the user; they are not bundled or redistributed
by pi-meldivo.
