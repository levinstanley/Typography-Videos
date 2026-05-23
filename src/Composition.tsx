import {useCallback, useEffect, useMemo, useState} from "react";
import {
	AbsoluteFill,
	Audio,
	Sequence,
	staticFile,
	useCurrentFrame,
	useDelayRender,
	useVideoConfig,
} from "remotion";
import type {Caption} from "@remotion/captions";

const AUDIO_FILE = "narration.mp3";
const CAPTIONS_FILE = "captions.json";
const TRANSCRIPT_FILE = "transcript.txt";
const CONFIG_FILE = "video.config.json";

type WordSpan = {
	charStart: number;
	charEnd: number;
	startMs: number;
	endMs: number;
};

type DisplayLine = {
	text: string;
	startMs: number;
	endMs: number;
	holdAfterLineMs?: number;
	speedFactor?: number;
	wordSpans: WordSpan[];
};

type Theme = {
	id: string;
	background:
		| {type: "solid"; color: string}
		| {type: "linear-gradient"; colorA: string; colorB: string; colorC: string}
		| {
				type: "ambient";
				base: string;
				accentA: string;
				accentB: string;
				accentC: string;
				opacity?: number;
		  };
	text: {
		color: string;
		fontFamily: string;
		fontSize: number;
		fontWeight: number;
		letterSpacing: number;
		lineHeight: number;
		maxLineChars: number;
		textBlockWidth: number;
		align: "left";
	};
	typing: {
		audioDelayMs: number;
		speedFactor: number;
		holdAfterLineMs: number;
		fadeMinMs: number;
		fadeMaxMs: number;
		introFadeMs: number;
		introGapMs: number;
	};
};

type VideoConfig = {
	theme?: string;
	switchToTheme?: string;
	switchOnWord?: string;
	themeSwitchDurationMs?: number;
	lineTimingOverrides?: LineTimingOverride[];
	introTitle?: string;
};

type LineTimingOverride = {
	lineStartsWith?: string;
	startOffsetMs?: number;
	wordOffsetMs?: number;
	endOffsetMs?: number;
	holdAfterLineMs?: number;
	speedFactor?: number;
};

const cleanText = (text: string) => text.trim().replace(/\s+/g, " ");
const wordsFor = (text: string) => cleanText(text).split(/\s+/).filter(Boolean);
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
const smooth = (value: number) => {
	const t = clamp(value, 0, 1);
	return t * t * (3 - 2 * t);
};

const parseHexColor = (color: string) => {
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

const blendHexColor = (from: string, to: string, progress: number) => {
	const fromRgb = parseHexColor(from);
	const toRgb = parseHexColor(to);
	if (!fromRgb || !toRgb) {
		return progress < 0.5 ? from : to;
	}

	const mix = (a: number, b: number) => Math.round(a + (b - a) * progress);
	return `#${[mix(fromRgb.r, toRgb.r), mix(fromRgb.g, toRgb.g), mix(fromRgb.b, toRgb.b)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
};

const mergeTheme = (from: Theme, to: Theme, progress: number): Theme => ({
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
			from.typing.fadeMinMs +
			(to.typing.fadeMinMs - from.typing.fadeMinMs) * progress,
		fadeMaxMs:
			from.typing.fadeMaxMs +
			(to.typing.fadeMaxMs - from.typing.fadeMaxMs) * progress,
	},
});

const mergeDisplayLines = (rawLines: string[]) => {
	const merged: string[] = [];

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

const findLineTimingOverride = (
	lineText: string,
	overrides: LineTimingOverride[] = [],
) =>
	overrides.find((override) => {
		const startsWith = cleanText(override.lineStartsWith ?? "");
		return startsWith.length > 0 && lineText.startsWith(startsWith);
	}) ?? {};

const buildLines = (
	captions: Caption[],
	transcript: string,
	theme: Theme,
	lineTimingOverrides: LineTimingOverride[] = [],
) => {
	const rawLines = transcript
		.split(/\r?\n/)
		.map((line) => cleanText(line))
		.filter(Boolean);
	const transcriptLines = mergeDisplayLines(rawLines);
	let captionIndex = 0;

	return transcriptLines.map((text, index) => {
		const lineWords = wordsFor(text);
		const firstCaption = captions[captionIndex];
		const lastCaption = captions[captionIndex + lineWords.length - 1];
		const timingOverride = findLineTimingOverride(text, lineTimingOverrides);
		const startOffsetMs = timingOverride.startOffsetMs ?? 0;
		const wordOffsetMs = timingOverride.wordOffsetMs ?? startOffsetMs;
		const endOffsetMs = timingOverride.endOffsetMs ?? startOffsetMs;
		let charCursor = 0;
		const wordSpans = lineWords.map((word, wordIndex) => {
			const caption = captions[captionIndex + wordIndex];
			const charStart = text.indexOf(word, charCursor);
			const charEnd =
				charStart + word.length + (wordIndex < lineWords.length - 1 ? 1 : 0);
			charCursor = charEnd;

			return {
				charStart,
				charEnd,
				startMs: Math.max(
					0,
					caption.startMs + theme.typing.audioDelayMs + wordOffsetMs,
				),
				endMs: Math.max(
					0,
					caption.endMs + theme.typing.audioDelayMs + wordOffsetMs,
				),
			};
		});

		captionIndex += lineWords.length;

		return {
			text,
			startMs:
				index === 0
					? 0
					: Math.max(
							0,
							firstCaption.startMs + theme.typing.audioDelayMs + startOffsetMs,
						),
			endMs: Math.max(
				0,
				lastCaption.endMs + theme.typing.audioDelayMs + endOffsetMs,
			),
			holdAfterLineMs: timingOverride.holdAfterLineMs,
			speedFactor: timingOverride.speedFactor,
			wordSpans,
		};
	});
};

const activeLineAt = (lines: DisplayLine[], timeMs: number, theme: Theme) => {
	let active: DisplayLine | null = null;

	for (const line of lines) {
		if (timeMs < line.startMs) {
			break;
		}

		if (timeMs <= line.endMs) {
			return line;
		}

		active = line;
	}

	return active &&
		timeMs <= active.endMs + (active.holdAfterLineMs ?? theme.typing.holdAfterLineMs)
		? active
		: null;
};

const opacityForLine = (line: DisplayLine, timeMs: number, theme: Theme) => {
	const duration = Math.max(120, line.endMs - line.startMs);
	const fadeMs = clamp(
		duration * 0.06,
		theme.typing.fadeMinMs,
		theme.typing.fadeMaxMs,
	);
	const inOpacity = smooth((timeMs - line.startMs) / fadeMs);
	const outOpacity = smooth(
		(line.endMs + (line.holdAfterLineMs ?? theme.typing.holdAfterLineMs) - timeMs) /
			fadeMs,
	);
	return clamp(Math.min(inOpacity, outOpacity), 0, 1);
};

const typedCharsForLine = (line: DisplayLine, timeMs: number, theme: Theme) => {
	const speedFactor = line.speedFactor ?? theme.typing.speedFactor;

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
			const progress = clamp(
				(timeMs - word.startMs) / (duration * speedFactor),
				0,
				1,
			);
			return Math.min(
				word.charEnd,
				word.charStart +
					Math.floor(progress * (word.charEnd - word.charStart + 1)),
			);
		}
	}

	return line.text.length;
};

const backgroundStyleFor = (theme: Theme, timeMs: number) => {
	const background = theme.background;

	if (background.type === "linear-gradient") {
		return `linear-gradient(135deg, ${background.colorA} 0%, ${background.colorB} 55%, ${background.colorC} 100%)`;
	}

	if (background.type === "ambient") {
		const x = 50 + Math.sin(timeMs / 9000) * 8;
		const y = 48 + Math.cos(timeMs / 11000) * 7;
		const x2 = 52 + Math.cos(timeMs / 13000) * 9;
		const opacity = background.opacity ?? 0.35;
		return [
			`radial-gradient(circle at ${x}% ${y}%, color-mix(in srgb, ${background.accentA} ${opacity * 100}%, transparent) 0%, transparent 58%)`,
			`radial-gradient(circle at ${x2}% 78%, color-mix(in srgb, ${background.accentC} ${opacity * 48}%, transparent) 0%, transparent 62%)`,
			background.base,
		].join(", ");
	}

	return background.color;
};

export const OneWordAudioVideo: React.FC = () => {
	const [lines, setLines] = useState<DisplayLine[] | null>(null);
	const [theme, setTheme] = useState<Theme | null>(null);
	const [switchTheme, setSwitchTheme] = useState<Theme | null>(null);
	const [switchStartMs, setSwitchStartMs] = useState(Number.POSITIVE_INFINITY);
	const [switchDurationMs, setSwitchDurationMs] = useState(460);
	const [introTitle, setIntroTitle] = useState("");
	const {delayRender, continueRender, cancelRender} = useDelayRender();
	const [handle] = useState(() => delayRender("Loading typed narration config"));
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const timeMs = (frame / fps) * 1000;

	const loadData = useCallback(async () => {
		try {
			const configResponse = await fetch(staticFile(CONFIG_FILE));
			const config = (await configResponse.json()) as VideoConfig;
			const themeId = config.theme ?? "typewriter-light";
			const switchThemeId = config.switchToTheme;
			const [captionsResponse, transcriptResponse, themeResponse, switchThemeResponse] =
				await Promise.all([
					fetch(staticFile(CAPTIONS_FILE)),
					fetch(staticFile(TRANSCRIPT_FILE)),
					fetch(staticFile(`themes/${themeId}.json`)),
					switchThemeId
						? fetch(staticFile(`themes/${switchThemeId}.json`))
						: Promise.resolve(null),
				]);
			const data = (await captionsResponse.json()) as Caption[];
			const transcript = await transcriptResponse.text();
			const loadedTheme = (await themeResponse.json()) as Theme;
			const captions = data.filter((caption) => cleanText(caption.text).length > 0);
			const loadedSwitchTheme = switchThemeResponse
				? ((await switchThemeResponse.json()) as Theme)
				: null;
			const switchWord = cleanText(config.switchOnWord ?? "").toLowerCase();
			const switchCaption = switchWord
				? captions.find(
						(caption) => cleanText(caption.text).toLowerCase() === switchWord,
					)
				: null;
			setTheme(loadedTheme);
			setSwitchTheme(loadedSwitchTheme);
			setSwitchStartMs(
				loadedSwitchTheme && switchCaption
					? switchCaption.startMs + loadedTheme.typing.audioDelayMs - 80
					: Number.POSITIVE_INFINITY,
			);
			setSwitchDurationMs(config.themeSwitchDurationMs ?? 460);
			setIntroTitle(config.introTitle ?? "");
			setLines(
				buildLines(
					captions,
					transcript,
					loadedTheme,
					config.lineTimingOverrides ?? [],
				),
			);
			continueRender(handle);
		} catch (error) {
			cancelRender(error);
		}
	}, [cancelRender, continueRender, handle]);

	useEffect(() => {
		loadData();
	}, [loadData]);

	const displayTheme =
		theme && switchTheme
			? mergeTheme(theme, switchTheme, smooth((timeMs - switchStartMs) / switchDurationMs))
			: theme;
	const activeLine =
		lines && displayTheme ? activeLineAt(lines, timeMs, displayTheme) : null;
	const opacity =
		activeLine && displayTheme ? opacityForLine(activeLine, timeMs, displayTheme) : 0;
	const typedChars =
		activeLine && displayTheme ? typedCharsForLine(activeLine, timeMs, displayTheme) : 0;
	const visibleText = activeLine
		? [...activeLine.text].slice(0, typedChars).join("")
		: "";
	const firstWordStartMs = lines?.[0]?.wordSpans[0]?.startMs ?? 0;
	const introEndMs = displayTheme ? firstWordStartMs - displayTheme.typing.introGapMs : 0;
	const showIntro = Boolean(displayTheme && introTitle && timeMs < introEndMs);
	const introOpacity =
		displayTheme && showIntro
			? smooth((introEndMs - timeMs) / displayTheme.typing.introFadeMs)
			: 0;
	const stageStyle = useMemo(
		() => ({
			background: displayTheme ? backgroundStyleFor(displayTheme, timeMs) : "#F5F5F7",
		}),
		[displayTheme, timeMs],
	);
	const sentenceStyle = displayTheme
		? {
				color: displayTheme.text.color,
				fontFamily: displayTheme.text.fontFamily,
				fontSize: displayTheme.text.fontSize,
				fontWeight: displayTheme.text.fontWeight,
				letterSpacing: displayTheme.text.letterSpacing,
				lineHeight: `${displayTheme.text.lineHeight}px`,
				opacity: showIntro ? introOpacity : opacity,
				width: Math.min(displayTheme.text.textBlockWidth, 1760),
		  }
		: undefined;

	return (
		<AbsoluteFill className="stage" style={stageStyle}>
			{theme ? (
				<Sequence from={Math.round((theme.typing.audioDelayMs / 1000) * fps)}>
					<Audio src={staticFile(AUDIO_FILE)} />
				</Sequence>
			) : null}
			<div className="sentence" style={sentenceStyle}>
				{showIntro ? introTitle : visibleText}
			</div>
		</AbsoluteFill>
	);
};
