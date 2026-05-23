import fs from "node:fs";
import path from "node:path";
import {
  downloadWhisperModel,
  installWhisperCpp,
  toCaptions,
  transcribe,
} from "@remotion/install-whisper-cpp";

const root = process.cwd();
const whisperPath = path.join(root, "whisper.cpp");
const model = "base.en";
const whisperCppVersion = "1.5.5";
const inputPath = path.join(root, "public", "narration.wav");
const outputPath = path.join(root, "public", "whisper-captions.json");

const progressLine = (label) => (progress) => {
  process.stdout.write(`\r${label}: ${Math.round(progress * 100)}%`);
};

console.log("Installing Whisper.cpp...");
await installWhisperCpp({
  to: whisperPath,
  version: whisperCppVersion,
  printOutput: true,
});

console.log("\nDownloading model...");
await downloadWhisperModel({
  model,
  folder: whisperPath,
  printOutput: true,
  onProgress: progressLine("Model"),
});

console.log("\nTranscribing audio...");
const whisperCppOutput = await transcribe({
  model,
  whisperPath,
  whisperCppVersion,
  inputPath,
  tokenLevelTimestamps: true,
  language: "en",
  additionalArgs: ["--split-on-word", "--no-gpu"],
  printOutput: true,
  onProgress: progressLine("Transcription"),
});

const { captions } = toCaptions({ whisperCppOutput });
fs.writeFileSync(outputPath, `${JSON.stringify(captions, null, 2)}\n`);

console.log(`\nWrote ${captions.length} caption tokens to ${outputPath}`);
