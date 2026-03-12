const form = document.getElementById("upload-form");
const input = document.getElementById("video-input");
const dropZone = document.getElementById("drop-zone");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const fileLabel = document.getElementById("file-label");
const results = document.getElementById("results");
const transcriptText = document.getElementById("transcript-text");
const meta = document.getElementById("meta");
const apiBaseInput = document.getElementById("api-base");
const providerSelect = document.getElementById("provider");
const localWhisperModelWrap = document.getElementById("local-whisper-model-wrap");
const localWhisperModelSelect = document.getElementById("local-whisper-model");
const copyBtn = document.getElementById("copy-btn");
const downloadTxt = document.getElementById("download-txt");
const downloadSrt = document.getElementById("download-srt");
const downloadVtt = document.getElementById("download-vtt");

const appConfig = window.__APP_CONFIG__ || {};
if (appConfig.apiBaseUrl) {
  apiBaseInput.value = appConfig.apiBaseUrl;
}

let latestPayload = null;
let serverReady = false;

apiBaseInput.addEventListener("change", () => {
  bootstrapHealthCheck();
});

providerSelect.addEventListener("change", () => {
  providerSelect.dataset.touched = "1";
  setProviderUiState();
  bootstrapHealthCheck();
});

setProviderUiState();
bootstrapHealthCheck();

input.addEventListener("change", () => {
  reflectSelectedFile();
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");

  const file = event.dataTransfer.files[0];
  if (!file) {
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  input.files = dataTransfer.files;
  reflectSelectedFile();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = input.files[0];
  if (!file) {
    setStatus("Select an MP4 first.", true);
    return;
  }

  submitBtn.disabled = true;
  results.classList.add("hidden");
  setStatus("Uploading and generating transcript...");

  try {
    const formData = new FormData();
    formData.append("video", file);

    const provider = providerSelect.value;
    formData.append("provider", provider);
    if (provider === "local_whisper") {
      formData.append("localWhisperModel", localWhisperModelSelect.value);
    }

    const endpoint = `${resolveApiBase()}/api/transcript`;
    const response = await fetch(endpoint, {
      method: "POST",
      body: formData
    });

    const rawBody = await response.text();
    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (_err) {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(payload.error || `Transcript request failed (${response.status}).`);
    }

    latestPayload = payload;
    renderTranscript(payload, file.name);
    setStatus("Transcript generated successfully.");
  } catch (error) {
    if (error && error.name === "TypeError") {
      setStatus("Could not reach backend. Check that npm run dev is still running.", true);
      return;
    }
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    submitBtn.disabled = !serverReady;
  }
});

copyBtn.addEventListener("click", async () => {
  if (!latestPayload || !latestPayload.text) {
    return;
  }

  await navigator.clipboard.writeText(latestPayload.text);
  setStatus("Transcript copied.");
});

downloadTxt.addEventListener("click", () => {
  if (!latestPayload) {
    return;
  }
  downloadTextFile("transcript.txt", latestPayload.text || "", "text/plain;charset=utf-8");
});

downloadSrt.addEventListener("click", () => {
  if (!latestPayload) {
    return;
  }
  downloadTextFile("transcript.srt", latestPayload.srt || "", "application/x-subrip");
});

downloadVtt.addEventListener("click", () => {
  if (!latestPayload) {
    return;
  }
  downloadTextFile("transcript.vtt", latestPayload.vtt || "", "text/vtt;charset=utf-8");
});

function reflectSelectedFile() {
  const file = input.files[0];
  fileLabel.textContent = file ? `Selected: ${file.name}` : "Click to choose an MP4";
}

function resolveApiBase() {
  const chosen = apiBaseInput.value.trim();
  if (chosen) {
    return chosen.replace(/\/$/, "");
  }

  const configured = String(appConfig.apiBaseUrl || "").trim();
  return configured ? configured.replace(/\/$/, "") : "";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b42318" : "";
}

async function bootstrapHealthCheck() {
  const endpoint = `${resolveApiBase()}/api/health`;
  setStatus("Checking server readiness...");

  try {
    const response = await fetch(endpoint);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Health check failed.");
    }

    if (payload.defaultProvider && !providerSelect.dataset.touched) {
      providerSelect.value = payload.defaultProvider;
    }

    if (payload.localWhisperModel) {
      localWhisperModelSelect.value = payload.localWhisperModel;
    }

    setProviderUiState();

    const provider = providerSelect.value;
    const issues = [];

    if (!payload.ffmpegAvailable) {
      issues.push("ffmpeg is not available on the backend");
    }

    if (provider === "local_whisper" && !payload.localWhisperAvailable) {
      issues.push("local whisper is not available on the backend");
    }

    if (provider === "openai" && !payload.openAiConfigured) {
      issues.push("OPENAI_API_KEY is not configured");
    }

    if (issues.length) {
      serverReady = false;
      submitBtn.disabled = true;
      setStatus(`Server reachable, but ${issues.join(" and ")}.`, true);
      return;
    }

    serverReady = true;
    submitBtn.disabled = false;
    setStatus(`Server ready (${providerLabel(provider)}). Upload an MP4 and generate transcript.`);
  } catch (_error) {
    serverReady = false;
    submitBtn.disabled = true;
    setStatus("Cannot reach API. Start server with `npm run dev`.", true);
  }
}

function setProviderUiState() {
  const usingLocalWhisper = providerSelect.value === "local_whisper";
  localWhisperModelWrap.classList.toggle("hidden-control", !usingLocalWhisper);
  localWhisperModelSelect.disabled = !usingLocalWhisper;
}

function providerLabel(provider) {
  return provider === "openai" ? "OpenAI" : "Local Whisper";
}

function renderTranscript(payload, fileName) {
  const safeName = stripExtension(fileName || "video");
  transcriptText.value = payload.text || "";

  const words = countWords(payload.text || "");
  const durationLabel = payload.duration ? formatDuration(payload.duration) : "n/a";
  const source = `${providerLabel(payload.provider)} • ${payload.model || "default model"}`;
  meta.textContent = `${safeName} • ${payload.language || "unknown"} • ${words} words • ${durationLabel} • ${source}`;

  results.classList.remove("hidden");
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^/.]+$/, "");
}

function countWords(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function formatDuration(secondsRaw) {
  const total = Math.max(0, Math.floor(Number(secondsRaw) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function downloadTextFile(fileName, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
