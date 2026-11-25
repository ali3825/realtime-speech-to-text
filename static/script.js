const $ = (id) => document.getElementById(id);

const startButton = $("startButton");
const stopButton = $("stopButton");
const saveLiveButton = $("saveLiveButton");
const copyLiveButton = $("copyLiveButton");
const clearLiveButton = $("clearLiveButton");
const liveTranscript = $("liveTranscript");
const liveCount = $("liveCount");
const recordingStatus = $("recordingStatus");
const recorder = $("recorder");
const timerEl = $("timer");
const meter = $("meter");

const audioFile = $("audioFile");
const dropzone = $("dropzone");
const dropTitle = $("dropTitle");
const fileName = $("fileName");
const uploadButton = $("uploadButton");
const uploadStatus = $("uploadStatus");
const uploadTranscript = $("uploadTranscript");
const uploadCount = $("uploadCount");
const saveUploadButton = $("saveUploadButton");
const copyUploadButton = $("copyUploadButton");

const historyContainer = $("historyContainer");
const refreshButton = $("refreshButton");
const historyToggle = $("historyToggle");
const historyCount = $("historyCount");
const closeHistory = $("closeHistory");
const drawer = $("historyDrawer");
const scrim = $("scrim");
const toast = $("toast");

const TARGET_SAMPLE_RATE = 16000;
const BARS = 36;

let socket = null;
let audioContext = null;
let processor = null;
let microphone = null;

let liveTurns = {};
let lastError = null;
let closeTimer = null;
let timerId = null;
let startedAt = 0;

// --------------------------------
// HELPERS
// --------------------------------

function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function wordCount(text) {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

function plural(n) {
    return `${n} ${n === 1 ? "word" : "words"}`;
}

function setState(state, text) {
    recorder.dataset.state = state;
    recordingStatus.textContent = text;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast("Copied to clipboard");
    } catch {
        showToast("Could not copy. Select the text and copy it manually.");
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// -------------------------------- TABS --------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => {
            const active = t === tab;
            t.classList.toggle("is-active", active);
            t.setAttribute("aria-selected", String(active));
        });

        $("paneLive").hidden = tab.dataset.tab !== "live";
        $("paneUpload").hidden = tab.dataset.tab !== "upload";
    });
});

// -------------------------------- WAVEFORM and  TIMER--------------------------------

const bars = Array.from({ length: BARS }, () => meter.appendChild(document.createElement("i")));
let levels = new Array(BARS).fill(0);

function pushLevel(value) {
    levels.push(value);
    levels.shift();
    bars.forEach((bar, i) => {
        bar.style.height = `${4 + levels[i] * 56}px`;
    });
}

function resetMeter() {
    levels.fill(0);
    pushLevel(0);
}

function tick() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent =
        String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function startTimer() {
    clearInterval(timerId);
    startedAt = Date.now();
    tick();
    timerId = setInterval(tick, 500);
}

resetMeter();

// -------------------------------- LIVE TRANSCRIPTION--------------------------------

startButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);

function updateLiveUI() {
    const text = liveTranscript.value;
    const empty = text.trim().length === 0;

    liveCount.textContent = plural(wordCount(text));
    saveLiveButton.disabled = empty;
    copyLiveButton.disabled = empty;
    clearLiveButton.disabled = empty;
}

liveTranscript.addEventListener("input", updateLiveUI);

function renderLive() {
    const orders = Object.keys(liveTurns).map(Number).sort((a, b) => a - b);

    liveTranscript.value = orders
        .map((order) => (liveTurns[order] || "").trim())
        .filter(Boolean)
        .join(" ");

    liveTranscript.scrollTop = liveTranscript.scrollHeight;
    updateLiveUI();
}

clearLiveButton.addEventListener("click", () => {
    liveTurns = {};
    liveTranscript.value = "";
    updateLiveUI();
});

copyLiveButton.addEventListener("click", () => copyText(liveTranscript.value));

async function startRecording() {
    lastError = null;
    liveTurns = {};
    liveTranscript.value = "";
    timerEl.textContent = "00:00";
    updateLiveUI();

    startButton.disabled = true;
    setState("connecting", "Waiting for microphone...");

    try {
        microphone = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
    } catch (error) {
        setState("error", error.message || "Could not access the microphone.");
        startButton.disabled = false;
        return;
    }

    setState("connecting", "Connecting...");
    stopButton.disabled = false;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/ws/transcribe`);
    socket.binaryType = "arraybuffer";

    socket.onmessage = (event) => {
        let data;

        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        if (data.type === "ready") {
            startAudioCapture();
            startTimer();
            setState("live", "Listening. Speak now.");
        }

        if (data.type === "turn") {
            liveTurns[data.order] = data.text || "";
            renderLive();
        }

        if (data.type === "error") {
            lastError = data.message || "Transcription error.";
            setState("error", lastError);
            stopAudioCapture();
            clearInterval(timerId);
        }
    };

    socket.onerror = () => {
        if (!lastError) {
            lastError = "Could not connect to the server.";
            setState("error", lastError);
        }
    };

    socket.onclose = () => {
        clearTimeout(closeTimer);
        clearInterval(timerId);
        stopAudioCapture();
        resetMeter();
        socket = null;

        startButton.disabled = false;
        stopButton.disabled = true;

        if (!lastError) {
            setState("idle", "Recording ended.");
        }

        updateLiveUI();
    };
}

function startAudioCapture() {
    if (audioContext || !microphone) return;

    audioContext = new AudioContext();
    const inputRate = audioContext.sampleRate;

    const source = audioContext.createMediaStreamSource(microphone);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        const input = event.inputBuffer.getChannelData(0);

        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        pushLevel(Math.min(1, Math.sqrt(sum / input.length) * 7));

        socket.send(convertToPCM16(downsample(input, inputRate, TARGET_SAMPLE_RATE)));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
}

function stopAudioCapture() {
    if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
    }

    if (microphone) {
        microphone.getTracks().forEach((track) => track.stop());
        microphone = null;
    }

    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
}

function downsample(buffer, inputRate, outputRate) {
    if (inputRate === outputRate) return buffer;

    const ratio = inputRate / outputRate;
    const newLength = Math.floor(buffer.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), buffer.length);

        let sum = 0;
        for (let j = start; j < end; j++) sum += buffer[j];

        result[i] = sum / Math.max(1, end - start);
    }

    return result;
}

function convertToPCM16(floatAudio) {
    const pcm = new Int16Array(floatAudio.length);

    for (let i = 0; i < floatAudio.length; i++) {
        const sample = Math.max(-1, Math.min(1, floatAudio[i]));
        pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }

    return pcm.buffer;
}

function stopRecording() {
    stopAudioCapture();
    clearInterval(timerId);
    resetMeter();
    stopButton.disabled = true;

    if (socket && socket.readyState === WebSocket.OPEN) {
        setState("connecting", "Finishing...");
        socket.send(JSON.stringify({ type: "stop" }));

        closeTimer = setTimeout(() => {
            if (socket) socket.close();
        }, 5000);
    } else if (socket) {
        socket.close();
    }
}

saveLiveButton.addEventListener("click", () => {
    saveTranscript(liveTranscript.value, "microphone");
});

// -------------------------------- UPLOAD FILE--------------------------------

function updateUploadUI() {
    const text = uploadTranscript.value;
    const empty = text.trim().length === 0;

    uploadCount.textContent = plural(wordCount(text));
    saveUploadButton.disabled = empty;
    copyUploadButton.disabled = empty;
}

uploadTranscript.addEventListener("input", updateUploadUI);
copyUploadButton.addEventListener("click", () => copyText(uploadTranscript.value));

function showSelectedFile() {
    const file = audioFile.files[0];

    dropzone.classList.toggle("has-file", Boolean(file));
    uploadButton.disabled = !file;

    if (file) {
        dropTitle.textContent = file.name;
        fileName.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB. Click to choose a different file.`;
    }
}

audioFile.addEventListener("change", showSelectedFile);

["dragenter", "dragover"].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add("drag");
    })
);

["dragleave", "drop"].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.remove("drag");
    })
);

dropzone.addEventListener("drop", (event) => {
    if (event.dataTransfer.files.length) {
        audioFile.files = event.dataTransfer.files;
        showSelectedFile();
    }
});

uploadButton.addEventListener("click", uploadAudio);

async function uploadAudio() {
    const file = audioFile.files[0];

    if (!file) {
        uploadStatus.textContent = "Choose an audio file first.";
        return;
    }

    const formData = new FormData();
    formData.append("file", file);

    uploadButton.disabled = true;
    uploadStatus.textContent = "Transcribing. This can take a few seconds...";
    uploadTranscript.value = "";
    updateUploadUI();

    try {
        const response = await fetch("/api/transcriptions/upload", {
            method: "POST",
            body: formData
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.detail || "Upload failed.");
        }

        uploadTranscript.value = result.text || "";
        uploadStatus.textContent = "Done.";
        updateUploadUI();
    } catch (error) {
        uploadStatus.textContent = error.message || "Upload failed.";
    } finally {
        uploadButton.disabled = !audioFile.files[0];
    }
}

saveUploadButton.addEventListener("click", () => {
    saveTranscript(uploadTranscript.value, "upload");
});


// --------------------------------SAVE --------------------------------


async function saveTranscript(text, source) {
    if (!text.trim()) {
        showToast("There is nothing to save yet.");
        return;
    }

    try {
        const response = await fetch("/api/transcriptions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: text, source: source })
        });

        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || "Could not save transcript.");
        }

        showToast("Transcript saved");
        await loadHistory();
    } catch (error) {
        showToast(error.message || "Could not save transcript.");
    }
}


// --------------------------------History Drawer section ------------------------


function openHistory() {
    drawer.classList.add("open");
    scrim.classList.add("open");
    historyToggle.setAttribute("aria-expanded", "true");
    loadHistory();
    closeHistory.focus();
}

function closeDrawer() {
    drawer.classList.remove("open");
    scrim.classList.remove("open");
    historyToggle.setAttribute("aria-expanded", "false");
    historyToggle.focus();
}

historyToggle.addEventListener("click", openHistory);
closeHistory.addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
refreshButton.addEventListener("click", loadHistory);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer.classList.contains("open")) {
        closeDrawer();
    }
});

function formatDate(value) {
    const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value);
    const date = new Date(hasZone ? value : value + "Z");

    return date.toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit"
    });
}

async function loadHistory() {
    try {
        const response = await fetch("/api/transcriptions");

        if (!response.ok) {
            throw new Error("Could not load history.");
        }

        const records = await response.json();
        historyContainer.replaceChildren();

        historyCount.textContent = records.length;
        historyCount.hidden = records.length === 0;

        if (!records.length) {
            historyContainer.textContent = "Nothing saved yet. Saved transcripts will show up here.";
            return;
        }

        records.forEach((record) => {
            const item = el("article", "history-item");

            const meta = el("div", "history-meta");
            meta.append(
                el("span", "tag", record.source === "upload" ? "Audio file" : "Live"),
                el("span", "", formatDate(record.created_at))
            );

            const text = el("p", "", record.text);

            const actions = el("div", "actions");

            const copyButton = el("button", "ghost", "Copy");
            copyButton.addEventListener("click", () => copyText(record.text));

            const editButton = el("button", "ghost", "Edit");
            editButton.addEventListener("click", () => editTranscript(record));

            const deleteButton = el("button", "ghost danger", "Delete");
            deleteButton.addEventListener("click", () => deleteTranscript(record.id));

            actions.append(copyButton, editButton, deleteButton);
            item.append(meta, text, actions);
            historyContainer.appendChild(item);
        });
    } catch (error) {
        historyContainer.textContent = error.message || "Could not load history.";
    }
}

async function editTranscript(record) {
    const newText = prompt("Edit transcription:", record.text);

    if (newText === null || !newText.trim()) return;

    try {
        const response = await fetch(`/api/transcriptions/${record.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: newText })
        });

        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || "Could not update transcript.");
        }

        showToast("Transcript updated");
        await loadHistory();
    } catch (error) {
        showToast(error.message || "Could not update transcript.");
    }
}

async function deleteTranscript(id) {
    if (!confirm("Delete this transcript? This can't be undone.")) return;

    try {
        const response = await fetch(`/api/transcriptions/${id}`, { method: "DELETE" });

        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || "Could not delete transcript.");
        }

        showToast("Transcript deleted");
        await loadHistory();
    } catch (error) {
        showToast(error.message || "Could not delete transcript.");
    }
}

// -------------------------------- START --------------------------------

loadHistory();