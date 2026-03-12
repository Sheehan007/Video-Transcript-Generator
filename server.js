const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const morgan = require("morgan");
const multer = require("multer");
const OpenAI = require("openai");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const app = express();
const ROOT_DIR = process.cwd();
const TMP_UPLOAD_DIR = path.join(ROOT_DIR, "tmp", "uploads");
const TMP_AUDIO_DIR = path.join(ROOT_DIR, "tmp", "audio");
const TMP_WHISPER_DIR = path.join(ROOT_DIR, "tmp", "whisper");
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15 * 60 * 1000);

const TRANSCRIBE_PROVIDER = String(process.env.TRANSCRIBE_PROVIDER || "local_whisper").trim();
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const TRANSCRIBE_RETRIES = Number(process.env.TRANSCRIBE_RETRIES || 3);

const LOCAL_WHISPER_BIN = process.env.LOCAL_WHISPER_BIN || "whisper";
const LOCAL_WHISPER_MODEL = process.env.LOCAL_WHISPER_MODEL || "base";
const LOCAL_WHISPER_LANGUAGE = String(process.env.LOCAL_WHISPER_LANGUAGE || "").trim();
const LOCAL_WHISPER_TASK = process.env.LOCAL_WHISPER_TASK || "transcribe";

ensureDirectory(TMP_UPLOAD_DIR);
ensureDirectory(TMP_AUDIO_DIR);
ensureDirectory(TMP_WHISPER_DIR);

const ffmpegAvailable = isExecutableAvailable("ffmpeg", ["-version"]);
const localWhisperAvailable = isExecutableAvailable(LOCAL_WHISPER_BIN, ["--help"]);

const rawOpenAiApiKey = String(process.env.OPENAI_API_KEY || "").trim();
const placeholderKeys = new Set(["your_openai_api_key_here", "sk-...", "<your_openai_api_key>"]);
const openAiApiKey = placeholderKeys.has(rawOpenAiApiKey) ? "" : rawOpenAiApiKey;
const openai = openAiApiKey
  ? new OpenAI({
      apiKey: openAiApiKey,
      timeout: 180000,
      maxRetries: 2
    })
  : null;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".mp4";
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".mp4") {
      cb(new Error("Only .mp4 files are supported."));
      return;
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(ROOT_DIR, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    ffmpegAvailable,
    openAiConfigured: Boolean(openai),
    localWhisperAvailable,
    defaultProvider: resolveProvider(TRANSCRIBE_PROVIDER),
    openAiModel: TRANSCRIBE_MODEL,
    localWhisperModel: LOCAL_WHISPER_MODEL,
    maxUploadMb: MAX_UPLOAD_MB,
    now: new Date().toISOString()
  });
});

app.post("/api/transcript", upload.single("video"), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) {
    res.status(400).json({ error: "Missing file. Upload an MP4 in the `video` field." });
    return;
  }

  const provider = resolveProvider(req.body?.provider || TRANSCRIBE_PROVIDER);
  const requestedLocalModel = String(req.body?.localWhisperModel || "").trim();
  const localModel = requestedLocalModel || LOCAL_WHISPER_MODEL;

  const cleanupPaths = [uploadedFile.path];

  try {
    if (!ffmpegAvailable) {
      res.status(503).json({ error: "ffmpeg is not installed on the server." });
      return;
    }

    if (provider === "openai" && !openai) {
      res.status(503).json({ error: "OPENAI_API_KEY is not configured." });
      return;
    }

    if (provider === "local_whisper" && !localWhisperAvailable) {
      res.status(503).json({ error: `Local whisper CLI is not installed (${LOCAL_WHISPER_BIN}).` });
      return;
    }

    const audioPath = path.join(TMP_AUDIO_DIR, `${path.parse(uploadedFile.filename).name}.mp3`);
    cleanupPaths.push(audioPath);
    await extractAudioFromMp4(uploadedFile.path, audioPath);

    const transcriptPayload = provider === "openai"
      ? await transcribeWithOpenAi(audioPath)
      : await transcribeWithLocalWhisper(audioPath, {
          model: localModel,
          language: LOCAL_WHISPER_LANGUAGE,
          task: LOCAL_WHISPER_TASK
        });

    res.json({
      ...transcriptPayload,
      provider,
      model: transcriptPayload.model
    });
  } catch (error) {
    console.error(error);
    const message = formatTranscriptionError(error, provider);
    res.status(500).json({ error: message });
  } finally {
    await Promise.all(cleanupPaths.map(safeUnlink));
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (error && error.message) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: "Unexpected server error" });
});

const server = app.listen(PORT, HOST, () => {
  const status = ffmpegAvailable ? "ready" : "ffmpeg missing";
  console.log(`Video transcript server listening on http://${HOST}:${PORT} (${status})`);
});
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isExecutableAvailable(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function resolveProvider(providerRaw) {
  const normalized = String(providerRaw || "").trim().toLowerCase();
  if (normalized === "openai") {
    return "openai";
  }
  return "local_whisper";
}

function extractAudioFromMp4(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-acodec",
      "libmp3lame",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "96k",
      audioPath
    ];

    const child = spawn("ffmpeg", ffmpegArgs);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed (exit ${code}). ${stderr.slice(-400)}`));
    });
  });
}

async function transcribeWithOpenAi(audioPath) {
  const transcription = await transcribeOpenAiWithRetry(audioPath);

  const text = (transcription.text || "").trim();
  const duration = Number(transcription.duration || 0);

  const sourceSegments = Array.isArray(transcription.segments) ? transcription.segments : [];
  const fallbackSegments = text
    ? [{
        id: 0,
        start: 0,
        end: duration > 0 ? duration : 5,
        text
      }]
    : [];

  const normalizedSegments = normalizeSegments(sourceSegments.length ? sourceSegments : fallbackSegments);

  return {
    text,
    srt: toSrt(normalizedSegments),
    vtt: toVtt(normalizedSegments),
    language: transcription.language || "unknown",
    duration,
    segmentCount: normalizedSegments.length,
    model: TRANSCRIBE_MODEL
  };
}

async function transcribeOpenAiWithRetry(audioPath) {
  let lastError;

  for (let attempt = 1; attempt <= TRANSCRIBE_RETRIES; attempt += 1) {
    try {
      return await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: TRANSCRIBE_MODEL,
        response_format: "verbose_json"
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt === TRANSCRIBE_RETRIES) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }

  throw lastError;
}

async function transcribeWithLocalWhisper(audioPath, options) {
  const runId = uuidv4();
  const outDir = path.join(TMP_WHISPER_DIR, runId);
  await fsp.mkdir(outDir, { recursive: true });

  try {
    await runLocalWhisper(audioPath, outDir, options);

    const baseName = path.parse(audioPath).name;
    const txtPath = path.join(outDir, `${baseName}.txt`);
    const srtPath = path.join(outDir, `${baseName}.srt`);
    const vttPath = path.join(outDir, `${baseName}.vtt`);
    const jsonPath = path.join(outDir, `${baseName}.json`);

    const text = (await safeReadFile(txtPath)).trim();
    const srt = await safeReadFile(srtPath);
    const vtt = await safeReadFile(vttPath);

    const jsonRaw = await safeReadFile(jsonPath);
    const jsonPayload = parseJson(jsonRaw);

    const srtSegments = parseSrtSegments(srt);
    const duration = Number(jsonPayload?.duration || inferDurationFromSegments(srtSegments));

    return {
      text,
      srt,
      vtt,
      language: jsonPayload?.language || options.language || "unknown",
      duration,
      segmentCount: srtSegments.length,
      model: options.model || LOCAL_WHISPER_MODEL
    };
  } finally {
    await safeRmDir(outDir);
  }
}

function runLocalWhisper(audioPath, outputDir, options) {
  return new Promise((resolve, reject) => {
    const args = [
      audioPath,
      "--model",
      options.model,
      "--task",
      options.task,
      "--output_dir",
      outputDir,
      "--output_format",
      "all",
      "--fp16",
      "False"
    ];

    if (options.language) {
      args.push("--language", options.language);
    }

    const child = spawn(LOCAL_WHISPER_BIN, args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`whisper failed (exit ${code}). ${stderr.slice(-500)}`));
    });
  });
}

function normalizeSegments(segments) {
  return segments
    .map((seg, index) => ({
      id: Number.isFinite(Number(seg.id)) ? Number(seg.id) : index,
      start: Number(seg.start || 0),
      end: Number(seg.end || seg.start || 0),
      text: String(seg.text || "").trim()
    }))
    .filter((seg) => seg.text.length > 0)
    .map((seg) => ({
      ...seg,
      end: seg.end > seg.start ? seg.end : seg.start + 0.8
    }));
}

function toSrt(segments) {
  return segments
    .map((seg, index) => `${index + 1}\n${formatTimestamp(seg.start, "srt")} --> ${formatTimestamp(seg.end, "srt")}\n${seg.text}\n`)
    .join("\n")
    .trim();
}

function toVtt(segments) {
  const body = segments
    .map((seg) => `${formatTimestamp(seg.start, "vtt")} --> ${formatTimestamp(seg.end, "vtt")}\n${seg.text}\n`)
    .join("\n")
    .trim();

  return body ? `WEBVTT\n\n${body}` : "WEBVTT";
}

function formatTimestamp(totalSeconds, format) {
  const safeSeconds = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.floor((safeSeconds - Math.floor(safeSeconds)) * 1000);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const ms = String(milliseconds).padStart(3, "0");
  const separator = format === "srt" ? "," : ".";

  return `${hh}:${mm}:${ss}${separator}${ms}`;
}

function parseSrtSegments(srtText) {
  const blocks = String(srtText || "").trim().split(/\n\s*\n/).filter(Boolean);

  return blocks
    .map((block) => {
      const lines = block.split(/\r?\n/).filter(Boolean);
      if (lines.length < 3) {
        return null;
      }

      const timeLine = lines[1];
      const parts = timeLine.split("-->").map((part) => part.trim());
      if (parts.length !== 2) {
        return null;
      }

      return {
        start: parseSrtTimestamp(parts[0]),
        end: parseSrtTimestamp(parts[1]),
        text: lines.slice(2).join(" ")
      };
    })
    .filter(Boolean);
}

function parseSrtTimestamp(timestamp) {
  const match = String(timestamp).match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const ms = Number(match[4]);
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function inferDurationFromSegments(segments) {
  if (!segments.length) {
    return 0;
  }
  const last = segments[segments.length - 1];
  return Number(last.end || 0);
}

function parseJson(rawText) {
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch (_err) {
    return null;
  }
}

function isRetryableNetworkError(error) {
  const transportCode = String(error?.cause?.code || error?.code || "").toUpperCase();
  const retryableCodes = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);
  return error?.name === "APIConnectionError" || retryableCodes.has(transportCode);
}

function formatTranscriptionError(error, provider) {
  if (!error) {
    return "Transcript generation failed.";
  }

  if (provider === "local_whisper") {
    if (String(error?.message || "").includes("whisper failed")) {
      return error.message;
    }
    if (error?.code === "ENOENT") {
      return `Local whisper executable not found (${LOCAL_WHISPER_BIN}).`;
    }
  }

  if (error?.status === 401 || error?.status === 403) {
    return "OpenAI authentication failed. Check OPENAI_API_KEY and try again.";
  }

  if (error?.status === 429) {
    const errorCode = String(error?.code || error?.error?.code || "").toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    if (errorCode === "insufficient_quota" || message.includes("insufficient_quota") || message.includes("exceeded your current quota")) {
      return "OpenAI quota is exhausted. Add billing/credits, then retry.";
    }
    return "OpenAI rate limit reached. Wait a moment and retry.";
  }

  if (error?.status === 413) {
    return "The extracted audio is too large for one request. Try a shorter MP4.";
  }

  if (isRetryableNetworkError(error)) {
    const transportCode = error?.cause?.code || error?.code || "network_error";
    return `Network error while contacting OpenAI (${transportCode}). Disable VPN/proxy and retry.`;
  }

  return error?.message || "Transcript generation failed.";
}

async function safeReadFile(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (_err) {
    return "";
  }
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (_err) {
    // Ignore cleanup errors.
  }
}

async function safeRmDir(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch (_err) {
    // Ignore cleanup errors.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
