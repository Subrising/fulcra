// Executed exclusively by the candidate's own Electron-as-Node launcher.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

(async () => {
  const [archive, models] = process.argv.slice(2);
  const server = path.join(
    archive,
    "node_modules/@getpaseo/server/dist/server/server/speech/providers/local/sherpa",
  );
  const load = (file) => import(pathToFileURL(path.join(server, file)).href);
  const fromCandidate = createRequire(path.join(server, "sherpa-onnx-node-loader.js"));
  const nativePath = fromCandidate.resolve(`sherpa-onnx-darwin-${process.arch}`);
  assert(
    nativePath.startsWith(path.dirname(archive)),
    "Native speech runtime escaped the app bundle",
  );
  const logger = fromCandidate("pino")({ level: "silent" });
  const { SherpaOfflineRecognizerEngine } = await load("sherpa-offline-recognizer.js");
  const sttDir = path.join(models, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
  const stt = new SherpaOfflineRecognizerEngine(
    {
      model: {
        kind: "nemo_transducer",
        encoder: path.join(sttDir, "encoder.int8.onnx"),
        decoder: path.join(sttDir, "decoder.int8.onnx"),
        joiner: path.join(sttDir, "joiner.int8.onnx"),
        tokens: path.join(sttDir, "tokens.txt"),
      },
      numThreads: 1,
    },
    logger,
  );
  stt.free();
  const { SherpaOnnxTTS } = await load("sherpa-tts.js");
  const tts = new SherpaOnnxTTS(
    { preset: "kokoro-en-v0_19", modelDir: path.join(models, "kokoro-en-v0_19"), numThreads: 1 },
    logger,
  );
  tts.free();
  const { SherpaSileroVadSession } = await load("silero-vad-session.js");
  const { ensureSileroVadModel } = await load("silero-vad-provider.js");
  const modelPath = await ensureSileroVadModel(
    path.join(process.env.PASEO_HOME, "models/local-speech"),
    logger,
  );
  const vad = new SherpaSileroVadSession({ logger, config: { modelPath } });
  vad.close();
  console.log("Packaged local speech models loaded: Parakeet, Kokoro, Silero");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
