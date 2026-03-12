=======
# Vid Transcript Gem

Web-first MP4 transcript generator with Android and iOS packaging support.

## Features

- Upload `.mp4` videos and generate transcripts from the browser.
- Local Whisper is the default provider (no API quota dependency).
- Optional OpenAI provider as fallback.
- Download transcript files as `TXT`, `SRT`, and `VTT`.

## Tech Stack

- Backend/API: Node.js + Express + Multer + ffmpeg
- Transcription providers: Local Whisper CLI and OpenAI Audio Transcriptions API
- Frontend: Static HTML/CSS/JS
- Mobile packaging: Capacitor (Android/iOS)

## Prerequisites

- Node.js 20+
- `ffmpeg` in `PATH`
- Local Whisper CLI in `PATH` (for default local provider)

Install prerequisites on macOS:

```bash
brew install ffmpeg
python3 -m pip install -U openai-whisper
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start server:

```bash
npm run dev
```

4. Open app:

- [http://127.0.0.1:4310](http://127.0.0.1:4310)
- Health: [http://127.0.0.1:4310/api/health](http://127.0.0.1:4310/api/health)

## Localhost Quick Test (Web)

1. Start server:

```bash
npm run dev
```

2. Check readiness:

```bash
npm run health
```

Expected when local provider is ready:

- `"ffmpegAvailable": true`
- `"localWhisperAvailable": true`

3. Open [http://127.0.0.1:4310](http://127.0.0.1:4310), keep provider as **Local Whisper**, upload `.mp4`, click **Generate Transcript**.

## Provider Configuration

Environment variables in `.env`:

- `TRANSCRIBE_PROVIDER=local_whisper` or `openai`
- `LOCAL_WHISPER_MODEL=base` (local default model)
- `TRANSCRIBE_MODEL=gpt-4o-mini-transcribe` (used only for OpenAI provider)
- `OPENAI_API_KEY=...` (needed only for OpenAI provider)

The UI also lets users choose provider and local Whisper model per upload.

## API

### `POST /api/transcript`

Multipart form upload:

- File field: `video` (`.mp4`)
- Optional field: `provider` (`local_whisper` or `openai`)
- Optional field: `localWhisperModel` (`tiny|base|small|medium|large`)

Response JSON:

- `text`, `srt`, `vtt`
- `language`, `duration`, `segmentCount`
- `provider`, `model`

## Troubleshooting

- `local whisper is not available on the backend`: install whisper CLI and restart server.
- `OpenAI quota is exhausted`: add credits/billing, then retry.
- `Network error while contacting OpenAI (...)`: check VPN/proxy/firewall and retry.
- `ffmpeg is not installed on the server`: install `ffmpeg` and retry.

## Android and iOS

After web app is stable:

```bash
npm run mobile:add:android
npm run mobile:add:ios
npm run mobile:sync
```

If iOS setup fails due to CocoaPods:

```bash
brew install cocoapods
pod --version
```
