import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const transcriptPath = path.join(root, "public", "transcript.txt");
const whisperCaptionsPath = path.join(root, "public", "whisper-captions.json");
const outputPath = path.join(root, "public", "captions.json");

const transcript = fs.readFileSync(transcriptPath, "utf8");
const whisperCaptions = JSON.parse(fs.readFileSync(whisperCaptionsPath, "utf8"));

const normalize = (word) =>
  word
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9']/g, "")
    .replace(/^'+|'+$/g, "");

const exactWords = transcript
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'")
  .split(/\s+/)
  .map((word) => word.trim())
  .filter(Boolean);

const spokenWords = whisperCaptions
  .map((caption) => ({
    ...caption,
    normalized: normalize(caption.text.trim()),
  }))
  .filter((caption) => caption.normalized.length > 0);

const transcriptWords = exactWords.map((word) => ({
  text: word,
  normalized: normalize(word),
}));

if (transcriptWords.length === 0) {
  throw new Error("No transcript words found.");
}

if (spokenWords.length === 0) {
  throw new Error("No Whisper captions found.");
}

const levenshtein = (a, b) => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
};

const wordDistance = (a, b) => {
  if (a === b) return 0;
  const maxLength = Math.max(a.length, b.length, 1);
  return levenshtein(a, b) / maxLength;
};

const substitutionCost = (transcriptWord, spokenWord) => {
  if (transcriptWord.normalized === spokenWord.normalized) return 0;
  const distance = wordDistance(transcriptWord.normalized, spokenWord.normalized);
  if (distance <= 0.25) return 0.25;
  if (transcriptWord.normalized.length <= 2 || spokenWord.normalized.length <= 2) {
    return 1.15;
  }
  return 1.35;
};

const alignWords = () => {
  const rows = transcriptWords.length + 1;
  const cols = spokenWords.length + 1;
  const costs = Array.from({ length: rows }, () => new Float64Array(cols));
  const moves = Array.from({ length: rows }, () => new Uint8Array(cols));

  for (let i = 1; i < rows; i++) {
    costs[i][0] = i;
    moves[i][0] = 1;
  }

  for (let j = 1; j < cols; j++) {
    costs[0][j] = j;
    moves[0][j] = 2;
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const sub = costs[i - 1][j - 1] + substitutionCost(transcriptWords[i - 1], spokenWords[j - 1]);
      const del = costs[i - 1][j] + 1;
      const ins = costs[i][j - 1] + 1;
      const best = Math.min(sub, del, ins);
      costs[i][j] = best;
      moves[i][j] = best === sub ? 3 : best === del ? 1 : 2;
    }
  }

  const mapping = new Array(transcriptWords.length).fill(null);
  let i = transcriptWords.length;
  let j = spokenWords.length;

  while (i > 0 || j > 0) {
    const move = moves[i][j];
    if (move === 3) {
      mapping[i - 1] = j - 1;
      i--;
      j--;
    } else if (move === 1) {
      i--;
    } else {
      j--;
    }
  }

  return mapping;
};

const mappedIndices = alignWords();
const lastEndMs = spokenWords.reduce((max, caption) => Math.max(max, caption.endMs ?? 0), 0);

const timeForUnmappedWord = (index) => {
  let previousIndex = index - 1;
  while (previousIndex >= 0 && mappedIndices[previousIndex] === null) {
    previousIndex--;
  }

  let nextIndex = index + 1;
  while (nextIndex < mappedIndices.length && mappedIndices[nextIndex] === null) {
    nextIndex++;
  }

  if (previousIndex >= 0 && nextIndex < mappedIndices.length) {
    const previousTime = spokenWords[mappedIndices[previousIndex]].startMs;
    const nextTime = spokenWords[mappedIndices[nextIndex]].startMs;
    const progress = (index - previousIndex) / (nextIndex - previousIndex);
    return Math.round(previousTime + (nextTime - previousTime) * progress);
  }

  if (previousIndex >= 0) {
    return spokenWords[mappedIndices[previousIndex]].endMs + (index - previousIndex) * 180;
  }

  if (nextIndex < mappedIndices.length) {
    return Math.max(0, spokenWords[mappedIndices[nextIndex]].startMs - (nextIndex - index) * 180);
  }

  return Math.round((index / transcriptWords.length) * lastEndMs);
};

const findCompoundTiming = (word, mappedSpokenIndex) => {
  if (!word.text.includes("-") || mappedSpokenIndex === null) {
    return null;
  }

  const parts = word.text
    .split("-")
    .map(normalize)
    .filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const from = Math.max(0, mappedSpokenIndex - parts.length - 3);
  const to = Math.min(spokenWords.length - parts.length, mappedSpokenIndex + 3);

  for (let start = from; start <= to; start++) {
    const candidate = spokenWords.slice(start, start + parts.length);
    if (candidate.every((spokenWord, partIndex) => spokenWord.normalized === parts[partIndex])) {
      return {
        startMs: candidate[0].startMs,
        endMs: candidate[candidate.length - 1].endMs,
      };
    }
  }

  return null;
};

const compoundTimings = transcriptWords.map((word, index) =>
  findCompoundTiming(word, mappedIndices[index]),
);

const startTimes = transcriptWords.map((_, index) => {
  if (compoundTimings[index]) {
    return compoundTimings[index].startMs;
  }

  const spokenIndex = mappedIndices[index];
  if (spokenIndex !== null) {
    return spokenWords[spokenIndex].startMs;
  }

  return timeForUnmappedWord(index);
});

const captions = transcriptWords.map((word, index) => {
  const spokenIndex = mappedIndices[index];
  const startMs = Math.max(0, Math.round(startTimes[index]));
  const nextStart = startTimes[index + 1];
  const sourceEnd = compoundTimings[index]?.endMs ?? (spokenIndex !== null ? spokenWords[spokenIndex].endMs : startMs + 180);
  const endMs = Math.max(
    startMs + 70,
    Math.round(typeof nextStart === "number" ? nextStart : sourceEnd),
  );

  return {
    text: index === 0 ? word.text : ` ${word.text}`,
    startMs,
    endMs,
    timestampMs: Math.round((startMs + endMs) / 2),
    confidence: spokenIndex !== null ? spokenWords[spokenIndex].confidence : null,
  };
});

fs.writeFileSync(outputPath, `${JSON.stringify(captions, null, 2)}\n`);

const exactMatches = mappedIndices.filter(
  (spokenIndex, index) =>
    spokenIndex !== null &&
    transcriptWords[index].normalized === spokenWords[spokenIndex].normalized,
).length;

console.log(
  `Aligned ${transcriptWords.length} transcript words to ${spokenWords.length} Whisper timing tokens.`,
);
console.log(`Exact word anchors: ${exactMatches}`);
console.log(`Wrote ${outputPath}`);
