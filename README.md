# Typed Narration Video Template

A Remotion starter template for turning your own voice and transcript into a clean typography video with a typewriter animation.

It includes two starter themes:

- `typewriter-light`
- `typewriter-dark`

The default demo starts in light mode and switches to dark mode when the word `Dark` is spoken.

## Get Started

Install dependencies:

```console
npm install
```

Add your files:

- Put your voice recording at `public/narration.m4a`
- Put your script at `public/transcript.txt`

Generate timing:

```console
npm run convert-audio
npm run transcribe
npm run align
```

Render the video:

```console
npm run render
```

The rendered video will be saved to:

```text
out/Intro-to-typography-video.mp4
```

## Customize

Edit `public/video.config.json` to choose a theme, switch themes mid-video, or tune specific line timing.

Edit the theme files in `public/themes` to change:

- Background color
- Text color
- Font stack
- Font size
- Line height
- Text width
- Typing speed
- Hold and fade timing

## Themes

Render light mode:

```console
npm run render:light
```

Render dark mode:

```console
npm run render:dark
```

## Files To Edit

- `public/transcript.txt`, your visible script
- `public/video.config.json`, video behavior and timing
- `public/themes/typewriter-light.json`, light theme
- `public/themes/typewriter-dark.json`, dark theme
- `scripts/render-word-video.mjs`, custom frame renderer

Generated audio, captions, Whisper files, and rendered videos are ignored by Git.
