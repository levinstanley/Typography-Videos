import fs from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
import sharp from "sharp";

const root = process.cwd();
const width = 1920;
const height = 1080;
const fps = 30;
const frameConcurrency = 8;

const publicDir = path.join(root, "public");
const captionsPath = path.join(publicDir, "captions.json");
const transcriptPath = path.join(publicDir, "transcript.txt");
const configPath = path.join(publicDir, "video.config.json");
const framesDir = path.join(root, "out", "line-frames");
const defaultOutputPath = path.join(root, "out", "typed-narration-video.mp4");
const audioPath = path.join(publicDir, "narration.mp3");
const ffmpegPath = path.join(
  root,
  "node_modules",
  "@remotion",
  "compositor-darwin-arm64",
  "ffmpeg",
);
const ffmpegLibPath = path.dirname(ffmpegPath);

const defaults = {
  theme: "typewriter-light",
  switchToTheme: "",
  switchOnWord: "",
  themeSwitchDurationMs: 460,
  lineTimingOverrides: [],
  introTitle: "",
};

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=") || true];
  }),
);

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

const parseHexColor = (color) => {
  const hex = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return null;
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

const blendHexColor = (from, to, progress) => {
  const fromRgb = parseHexColor(from);
  const toRgb = parseHexColor(to);
  if (!fromRgb || !toRgb) {
    return progress < 0.5 ? from : to;
  }

  const mix = (a, b) => Math.round(a + (b - a) * progress);
  return `#${[mix(fromRgb.r, toRgb.r), mix(fromRgb.g, toRgb.g), mix(fromRgb.b, toRgb.b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
};

const mergeTheme = (from, to, progress) => ({
  ...from,
  background:
    from.background.type === "solid" && to.background.type === "solid"
      ? {
          type: "solid",
          color: blendHexColor(from.background.color, to.background.color, progress),
        }
      : progress < 0.5
        ? from.background
        : to.background,
  text: {
    ...from.text,
    color: blendHexColor(from.text.color, to.text.color, progress),
  },
  typing: {
    ...from.typing,
    holdAfterLineMs:
      from.typing.holdAfterLineMs +
      (to.typing.holdAfterLineMs - from.typing.holdAfterLineMs) * progress,
    fadeMinMs:
      from.typing.fadeMinMs + (to.typing.fadeMinMs - from.typing.fadeMinMs) * progress,
    fadeMaxMs:
      from.typing.fadeMaxMs + (to.typing.fadeMaxMs - from.typing.fadeMaxMs) * progress,
  },
});

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

const loadConfig = async () => {
  try {
    return {...defaults, ...(await readJson(configPath))};
  } catch {
    return defaults;
  }
};

const loadTheme = async (themeId) => {
  const themePath = path.join(publicDir, "themes", `${themeId}.json`);
  return readJson(themePath);
};

const wordsFor = (text) => text.trim().split(/\s+/).filter(Boolean);

const mergeDisplayLines = (rawLines) => {
  const merged = [];

  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index];

    if (/^(Not|But):$/i.test(line) && rawLines[index + 1]) {
      merged.push(`${line} ${rawLines[index + 1]}`);
      index++;
      continue;
    }

    merged.push(line);
  }

  return merged;
};

const wrapLine = (text, maxLineChars) => {
  const words = wordsFor(text);
  const lines = [];
  let current = "";
  let charStart = 0;
  let cursor = 0;

  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > maxLineChars && current.length > 0) {
      lines.push({
        text: current,
        charStart,
        charEnd: charStart + current.length,
      });
      charStart += current.length + 1;
      current = word;
      cursor = charStart + word.length;
    } else {
      current = next;
      cursor = charStart + current.length;
    }
  }

  if (current.length > 0) {
    lines.push({
      text: current,
      charStart,
      charEnd: cursor,
    });
  }

  return lines;
};

const activeLineAt = (lines, timeMs, holdAfterLineMs) => {
  let active = null;

  for (const line of lines) {
    if (timeMs < line.startMs) {
      break;
    }

    if (timeMs <= line.endMs) {
      return line;
    }

    active = line;
  }

  return active && timeMs <= active.endMs + (active.holdAfterLineMs ?? holdAfterLineMs)
    ? active
    : null;
};

const opacityForLine = (line, timeMs, timing) => {
  const duration = Math.max(120, line.endMs - line.startMs);
  const fadeMs = clamp(duration * 0.06, timing.fadeMinMs, timing.fadeMaxMs);
  const inOpacity = smooth((timeMs - line.startMs) / fadeMs);
  const outOpacity = smooth(
    (line.endMs + (line.holdAfterLineMs ?? timing.holdAfterLineMs) - timeMs) / fadeMs,
  );
  return clamp(Math.min(inOpacity, outOpacity), 0, 1);
};

const typedCharsForLine = (line, timeMs, speedFactor) => {
  const lineSpeedFactor = line.speedFactor ?? speedFactor;

  if (timeMs < line.startMs) {
    return 0;
  }

  if (timeMs >= line.endMs) {
    return line.text.length;
  }

  for (const word of line.wordSpans) {
    if (timeMs < word.startMs) {
      return word.charStart;
    }

    if (timeMs <= word.endMs) {
      const duration = Math.max(80, word.endMs - word.startMs);
      const progress = clamp((timeMs - word.startMs) / (duration * lineSpeedFactor), 0, 1);
      return Math.min(
        word.charEnd,
        word.charStart + Math.floor(progress * (word.charEnd - word.charStart + 1)),
      );
    }
  }

  return line.text.length;
};

const visibleTextForVisualLine = (line, visualLine, typedChars) => {
  const visibleChars = clamp(
    typedChars - visualLine.charStart,
    0,
    visualLine.charEnd - visualLine.charStart,
  );
  return escapeXml([...visualLine.text].slice(0, visibleChars).join(""));
};

const backgroundForSvg = (background, timeMs) => {
  if (background.type === "linear-gradient") {
    return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${background.colorA}"/>
      <stop offset="0.55" stop-color="${background.colorB}"/>
      <stop offset="1" stop-color="${background.colorC}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>`;
  }

  if (background.type === "ambient") {
    const driftX = 50 + Math.sin(timeMs / 9000) * 8;
    const driftY = 48 + Math.cos(timeMs / 11000) * 7;
    const driftX2 = 52 + Math.cos(timeMs / 13000) * 9;
    const opacity = background.opacity ?? 0.35;

    return `
  <defs>
    <radialGradient id="glowA" cx="${driftX.toFixed(2)}%" cy="${driftY.toFixed(2)}%" r="72%">
      <stop offset="0" stop-color="${background.accentA}" stop-opacity="${opacity}"/>
      <stop offset="0.62" stop-color="${background.accentB}" stop-opacity="${opacity * 0.38}"/>
      <stop offset="1" stop-color="${background.accentB}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="${driftX2.toFixed(2)}%" cy="78%" r="68%">
      <stop offset="0" stop-color="${background.accentC}" stop-opacity="${opacity * 0.45}"/>
      <stop offset="1" stop-color="${background.accentC}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${background.base}"/>
  <rect width="${width}" height="${height}" fill="url(#glowA)"/>
  <rect width="${width}" height="${height}" fill="url(#glowB)"/>`;
  }

  return `<rect width="${width}" height="${height}" fill="${background.color}"/>`;
};

const svgForFrame = ({lines, theme, displayTheme, introTitle}, timeMs) => {
  const text = displayTheme.text;
  const timing = displayTheme.typing;
  const textLeftX = (width - text.textBlockWidth) / 2;
  const firstWordStartMs = lines[0]?.wordSpans[0]?.startMs ?? 0;
  const introEndMs = firstWordStartMs - timing.introGapMs;
  const bg = backgroundForSvg(displayTheme.background, timeMs);

  if (introTitle && timeMs < introEndMs) {
    const introOpacity = smooth((introEndMs - timeMs) / timing.introFadeMs).toFixed(3);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
${bg}
  <text x="${textLeftX}" y="${height / 2}" text-anchor="start" dominant-baseline="middle"
    font-family="${text.fontFamily}"
    font-size="${text.fontSize}"
    font-weight="${text.fontWeight}"
    letter-spacing="${text.letterSpacing}"
    opacity="${introOpacity}"
    fill="${text.color}">${escapeXml(introTitle)}</text>
</svg>`;
  }

  const line = activeLineAt(lines, timeMs, timing.holdAfterLineMs);
  const opacity = line ? opacityForLine(line, timeMs, timing).toFixed(3) : "0";
  const typedChars = line ? typedCharsForLine(line, timeMs, timing.speedFactor) : 0;
  const blockHeight = line ? line.visualLines.length * text.lineHeight : 0;
  const yStart = height / 2 - blockHeight / 2 + text.lineHeight / 2;

  const renderedText = line
    ? line.visualLines
        .map((visualLine, index) => {
          const y = yStart + index * text.lineHeight;
          return `<text x="${textLeftX}" y="${y.toFixed(2)}" text-anchor="start" dominant-baseline="middle"
    font-family="${text.fontFamily}"
    font-size="${text.fontSize}"
    font-weight="${text.fontWeight}"
    letter-spacing="${text.letterSpacing}"
    fill="${text.color}">${visibleTextForVisualLine(line, visualLine, typedChars)}</text>`;
        })
        .join("\n")
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
${bg}
  <g opacity="${opacity}">
${renderedText}
  </g>
</svg>`;
};

const run = (command, runArgs, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, runArgs, {
      env: {...process.env, ...env},
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });

const findLineTimingOverride = (lineText, overrides) =>
  overrides.find((override) => {
    const startsWith = String(override.lineStartsWith ?? "").trim();
    return startsWith && lineText.startsWith(startsWith);
  }) ?? {};

const buildLines = ({captions, transcriptLines, audioDelayMs, maxLineChars, lineTimingOverrides}) => {
  let captionIndex = 0;
  const lines = transcriptLines.map((text, index) => {
    const lineWords = wordsFor(text);
    const firstCaption = captions[captionIndex];
    const lastCaption = captions[captionIndex + lineWords.length - 1];
    const timingOverride = findLineTimingOverride(text, lineTimingOverrides);
    const startOffsetMs = Number(timingOverride.startOffsetMs ?? 0);
    const wordOffsetMs = Number(timingOverride.wordOffsetMs ?? startOffsetMs);
    const endOffsetMs = Number(timingOverride.endOffsetMs ?? startOffsetMs);
    let charCursor = 0;
    const wordSpans = lineWords.map((word, wordIndex) => {
      const caption = captions[captionIndex + wordIndex];
      const charStart = text.indexOf(word, charCursor);
      const charEnd = charStart + word.length + (wordIndex < lineWords.length - 1 ? 1 : 0);
      charCursor = charEnd;

      return {
        charStart,
        charEnd,
        startMs: Math.max(0, caption.startMs + audioDelayMs + wordOffsetMs),
        endMs: Math.max(0, caption.endMs + audioDelayMs + wordOffsetMs),
      };
    });

    captionIndex += lineWords.length;

    if (!firstCaption || !lastCaption) {
      throw new Error(`Could not map transcript line to captions: ${text}`);
    }

    return {
      index,
      text,
      startMs: index === 0 ? 0 : Math.max(0, firstCaption.startMs + audioDelayMs + startOffsetMs),
      endMs: Math.max(0, lastCaption.endMs + audioDelayMs + endOffsetMs),
      holdAfterLineMs:
        timingOverride.holdAfterLineMs === undefined
          ? undefined
          : Number(timingOverride.holdAfterLineMs),
      speedFactor:
        timingOverride.speedFactor === undefined ? undefined : Number(timingOverride.speedFactor),
      wordSpans,
      visualLines: wrapLine(text, maxLineChars),
    };
  });

  if (captionIndex !== captions.length) {
    throw new Error(
      `Transcript/caption mismatch: used ${captionIndex} caption words for ${captions.length} captions`,
    );
  }

  return lines;
};

const config = await loadConfig();
const themeId = String(args.theme || config.theme || defaults.theme);
const theme = await loadTheme(themeId);
const switchToThemeId = String(args["switch-to-theme"] ?? config.switchToTheme ?? "");
const switchTheme = switchToThemeId ? await loadTheme(switchToThemeId) : null;
const introTitle = String(args["intro-title"] ?? config.introTitle ?? "");
const outputPath = args.out ? path.resolve(root, String(args.out)) : defaultOutputPath;

const captions = (await readJson(captionsPath))
  .map((caption) => ({
    text: caption.text.trim(),
    startMs: caption.startMs,
    endMs: caption.endMs,
  }))
  .filter((caption) => caption.text.length > 0);
const rawTranscriptLines = (await fs.readFile(transcriptPath, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const transcriptLines = mergeDisplayLines(rawTranscriptLines);
const lines = buildLines({
  captions,
  transcriptLines,
  audioDelayMs: theme.typing.audioDelayMs,
  maxLineChars: theme.text.maxLineChars,
  lineTimingOverrides: config.lineTimingOverrides ?? [],
});
const switchWord = String(args["switch-on-word"] ?? config.switchOnWord ?? "")
  .trim()
  .toLowerCase();
const switchCaption = switchWord
  ? captions.find((caption) => caption.text.trim().toLowerCase() === switchWord)
  : null;
const switchStartMs =
  switchTheme && switchCaption
    ? switchCaption.startMs + theme.typing.audioDelayMs - 80
    : Number.POSITIVE_INFINITY;
const switchDurationMs = Number(
  args["theme-switch-duration-ms"] ?? config.themeSwitchDurationMs ?? defaults.themeSwitchDurationMs,
);
const displayThemeAt = (timeMs) => {
  if (!switchTheme) {
    return theme;
  }

  const progress = smooth((timeMs - switchStartMs) / switchDurationMs);
  return mergeTheme(theme, switchTheme, progress);
};
const audioDurationMs = Math.max(
  ...captions.map((caption) => caption.endMs + theme.typing.audioDelayMs + 1000),
  0,
);

await fs.rm(framesDir, {recursive: true, force: true});
await fs.mkdir(framesDir, {recursive: true});
await fs.mkdir(path.dirname(outputPath), {recursive: true});

const frameCount = Math.ceil((audioDurationMs / 1000) * fps);
let renderedFrames = 0;

const renderFrame = async (frameIndex) => {
  const timeMs = (frameIndex / fps) * 1000;
  const displayTheme = displayThemeAt(timeMs);
  const filename = `frame-${String(frameIndex).padStart(6, "0")}.png`;
  const framePath = path.join(framesDir, filename);
  await sharp(Buffer.from(svgForFrame({lines, theme, displayTheme, introTitle}, timeMs)))
    .png()
    .toFile(framePath);

  renderedFrames++;
  if (renderedFrames % 1000 === 0 || renderedFrames === frameCount) {
    console.log(`Rendered ${renderedFrames}/${frameCount} frames`);
  }
};

let nextFrame = 0;
await Promise.all(
  Array.from({length: frameConcurrency}, async () => {
    while (nextFrame < frameCount) {
      const frameIndex = nextFrame;
      nextFrame++;
      await renderFrame(frameIndex);
    }
  }),
);

await run(
  ffmpegPath,
  [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, "frame-%06d.png"),
    "-i",
    audioPath,
    "-filter_complex",
    `[1:a]adelay=${theme.typing.audioDelayMs}|${theme.typing.audioDelayMs}[delayed_audio]`,
    "-map",
    "0:v:0",
    "-map",
    "[delayed_audio]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputPath,
  ],
  {DYLD_LIBRARY_PATH: ffmpegLibPath},
);

console.log(`Rendered ${outputPath}`);
