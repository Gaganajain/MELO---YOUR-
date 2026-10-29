// MELO: in-browser music player. Songs are kept in IndexedDB so they survive a reload.

const $ = (s) => document.querySelector(s);
const audio = $("#audio");

const state = {
  tracks: [],      // { id, title, artist, blob, url, liked, demo }
  order: [],       // indices into tracks, shuffled when shuffle is on
  current: -1,     // index into tracks
  shuffle: false,
  repeat: "off",   // off | all | one
  filter: "all",
  query: "",
  vizMode: "bars",
};

// ---------- IndexedDB ----------
const DB_NAME = "melo";
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbTx(mode, fn) {
  try {
    const store = (await db()).transaction("tracks", mode).objectStore("tracks");
    return await new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null; // storage unavailable (private mode etc.): the player still works for this session
  }
}

const saveTrack = (t) => dbTx("readwrite", (s) => s.put({ id: t.id, title: t.title, artist: t.artist, blob: t.blob, liked: t.liked, added: t.added }));
const deleteTrack = (id) => dbTx("readwrite", (s) => s.delete(id));
const loadTracks = () => dbTx("readonly", (s) => s.getAll());

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10);

function parseName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const parts = base.split(" - ");
  return parts.length > 1
    ? { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() }
    : { artist: "Unknown artist", title: base };
}

function fmt(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
}

function hueFor(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function setFill(range) {
  const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
  range.style.setProperty("--fill", `${pct}%`);
}

// ---------- library ----------
function addTrack(t) {
  t.url = URL.createObjectURL(t.blob);
  state.tracks.push(t);
}

async function addFiles(files) {
  const audioFiles = [...files].filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i.test(f.name));
  if (!audioFiles.length) return toast("Those aren't audio files");
  for (const f of audioFiles) {
    const t = { id: uid(), ...parseName(f.name), blob: f, liked: false, added: Date.now() };
    addTrack(t);
    saveTrack(t);
  }
  rebuildOrder();
  renderPlaylist();
  toast(`Added ${audioFiles.length} song${audioFiles.length > 1 ? "s" : ""}`);
  if (state.current === -1) loadTrack(state.order[0], false);
}

function removeTrack(index) {
  const [t] = state.tracks.splice(index, 1);
  URL.revokeObjectURL(t.url);
  if (!t.demo) deleteTrack(t.id);
  if (index === state.current) {
    audio.pause();
    audio.removeAttribute("src");
    state.current = -1;
    renderNowPlaying();
  } else if (index < state.current) {
    state.current--;
  }
  rebuildOrder();
  renderPlaylist();
}

function rebuildOrder() {
  const idx = state.tracks.map((_, i) => i);
  if (state.shuffle) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    // Keep the current song first so shuffling never interrupts it
    const pos = idx.indexOf(state.current);
    if (pos > 0) idx.unshift(...idx.splice(pos, 1));
  }
  state.order = idx;
}

function visibleTracks() {
  const q = state.query.toLowerCase();
  return state.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (state.filter === "all" || t.liked) && (!q || `${t.title} ${t.artist}`.toLowerCase().includes(q)));
}

function renderPlaylist() {
  const list = $("#playlist");
  const items = visibleTracks();
  list.classList.toggle("paused", audio.paused);
  list.innerHTML = items.map(({ t, i }, n) => `
    <li data-index="${i}" class="${i === state.current ? "active" : ""}">
      <span class="num">${i === state.current ? '<span class="eq"><i></i><i></i><i></i></span>' : n + 1}</span>
      <span class="t"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.artist)}</small></span>
      ${t.liked ? '<span class="heart">♥</span>' : ""}
      <button class="remove" data-remove="${i}" title="Remove" aria-label="Remove ${escapeHtml(t.title)}">✕</button>
    </li>`).join("");

  $("#emptyHint").style.display = state.tracks.length ? "none" : "block";
  if (state.tracks.length && !items.length) {
    list.innerHTML = `<p class="hint">${state.filter === "liked" ? "No liked songs yet. Tap ♡ on a song you love." : "No matches."}</p>`;
  }
}

// ---------- playback ----------
function loadTrack(index, autoplay = true) {
  if (index == null || !state.tracks[index]) return;
  state.current = index;
  audio.src = state.tracks[index].url;
  renderNowPlaying();
  renderPlaylist();
  if (autoplay) play();
}

async function play() {
  if (state.current === -1) {
    if (!state.tracks.length) return toast("Add a song first");
    return loadTrack(state.order[0]);
  }
  setupAnalyser();
  if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
  try {
    await audio.play();
  } catch {
    toast("Can't play this file in your browser");
  }
}

function togglePlay() {
  audio.paused ? play() : audio.pause();
}

function step(dir) {
  if (!state.tracks.length) return;
  if (dir < 0 && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const pos = state.order.indexOf(state.current);
  let next = pos + dir;
  if (next >= state.order.length) {
    if (state.repeat === "off" && dir > 0) {
      audio.pause();
      audio.currentTime = 0;
      return;
    }
    next = 0;
  }
  if (next < 0) next = state.order.length - 1;
  loadTrack(state.order[next]);
}

function renderNowPlaying() {
  const t = state.tracks[state.current];
  $("#title").textContent = t ? t.title : "Nothing playing";
  $("#artist").textContent = t ? t.artist : "Add a song to get started";
  $("#coverText").textContent = t ? t.title.trim().charAt(0).toUpperCase() || "♪" : "♪";
  $("#likeBtn").classList.toggle("on", !!t?.liked);
  $("#likeBtn").textContent = t?.liked ? "♥" : "♡";
  document.title = t ? `${t.title} · MELO` : "MELO: your music, your vibe";

  const hue = t ? hueFor(t.title + t.artist) : 270;
  document.documentElement.style.setProperty("--accent", `hsl(${hue} 85% 65%)`);
  document.documentElement.style.setProperty("--accent-2", `hsl(${(hue + 50) % 360} 85% 62%)`);
}

function toggleLike() {
  const t = state.tracks[state.current];
  if (!t) return;
  t.liked = !t.liked;
  if (!t.demo) saveTrack(t);
  renderNowPlaying();
  renderPlaylist();
  toast(t.liked ? "Added to Liked" : "Removed from Liked");
}

function setRepeat() {
  const next = { off: "all", all: "one", one: "off" }[state.repeat];
  state.repeat = next;
  audio.loop = next === "one";
  const btn = $("#repeatBtn");
  btn.classList.toggle("on", next !== "off");
  btn.textContent = next === "one" ? "🔂" : "🔁";
  toast(`Repeat: ${next}`);
}

function setShuffle() {
  state.shuffle = !state.shuffle;
  $("#shuffleBtn").classList.toggle("on", state.shuffle);
  rebuildOrder();
  toast(`Shuffle ${state.shuffle ? "on" : "off"}`);
}

function setVolume(v) {
  audio.volume = Math.min(1, Math.max(0, v));
  const vol = $("#volume");
  vol.value = audio.volume;
  setFill(vol);
  $("#muteBtn").textContent = audio.muted || audio.volume === 0 ? "🔇" : audio.volume < 0.5 ? "🔉" : "🔊";
}

// ---------- visualizer ----------
let audioCtx = null;
let analyser = null;
let freqData, timeData;
const canvas = $("#viz");
const ctx2d = canvas.getContext("2d");

function setupAnalyser() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  audioCtx.createMediaElementSource(audio).connect(analyser);
  analyser.connect(audioCtx.destination);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;
}

function draw() {
  requestAnimationFrame(draw);
  const { width: w, height: h } = canvas;
  ctx2d.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const grad = ctx2d.createLinearGradient(0, h, w, 0);
  grad.addColorStop(0, styles.getPropertyValue("--accent").trim());
  grad.addColorStop(1, styles.getPropertyValue("--accent-2").trim());

  let level = 0;
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);
    level = freqData.slice(0, 16).reduce((a, b) => a + b, 0) / (16 * 255);
  } else {
    freqData = freqData || new Uint8Array(128);
    timeData = timeData || new Uint8Array(256).fill(128);
  }

  ctx2d.fillStyle = grad;
  ctx2d.strokeStyle = grad;

  if (state.vizMode === "bars") {
    const bars = 64;
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = freqData[i] / 255;
      const bh = Math.max(2 * devicePixelRatio, v * h * 0.85);
      ctx2d.globalAlpha = 0.35 + v * 0.65;
      ctx2d.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
    }
  } else if (state.vizMode === "wave") {
    ctx2d.lineWidth = 3 * devicePixelRatio;
    ctx2d.globalAlpha = 1;
    ctx2d.beginPath();
    for (let i = 0; i < timeData.length; i++) {
      const x = (i / (timeData.length - 1)) * w;
      const y = (timeData[i] / 255) * h;
      i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y);
    }
    ctx2d.stroke();
  } else {
    const cx = w / 2, cy = h / 2;
    const base = Math.min(w, h) * 0.2;
    const n = 96;
    ctx2d.lineWidth = 3 * devicePixelRatio;
    for (let i = 0; i < n; i++) {
      const v = freqData[i % freqData.length] / 255;
      const a = (i / n) * Math.PI * 2;
      const r2 = base + 10 + v * base * 1.2;
      ctx2d.globalAlpha = 0.4 + v * 0.6;
      ctx2d.beginPath();
      ctx2d.moveTo(cx + Math.cos(a) * (base + 6), cy + Math.sin(a) * (base + 6));
      ctx2d.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx2d.stroke();
    }
  }
  ctx2d.globalAlpha = 1;
  $("#cover").style.scale = String(1 + level * 0.12);
}

// ---------- demo tracks (synthesised in the browser, no files needed) ----------
async function renderDemo(notes, bpm, wave, seconds = 16) {
  const rate = 44100;
  const off = new OfflineAudioContext(1, rate * seconds, rate);
  const beat = 60 / bpm;
  const master = off.createGain();
  master.gain.value = 0.25;
  master.connect(off.destination);

  for (let t = 0, i = 0; t < seconds - beat; t += beat / 2, i++) {
    const midi = notes[i % notes.length];
    if (midi == null) continue;
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = wave;
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + beat * 0.9);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + beat);

    if (i % 4 === 0) { // bass + kick on the beat
      const bass = off.createOscillator();
      const bg = off.createGain();
      bass.type = "sine";
      bass.frequency.value = 440 * Math.pow(2, (notes[0] - 12 - 69) / 12);
      bg.gain.setValueAtTime(0.8, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + beat * 1.8);
      bass.connect(bg).connect(master);
      bass.start(t);
      bass.stop(t + beat * 2);

      const kick = off.createOscillator();
      const kg = off.createGain();
      kick.frequency.setValueAtTime(150, t);
      kick.frequency.exponentialRampToValueAtTime(40, t + 0.15);
      kg.gain.setValueAtTime(1, t);
      kg.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      kick.connect(kg).connect(master);
      kick.start(t);
      kick.stop(t + 0.25);
    }
  }
  return toWav(await off.startRendering());
}

function toWav(buffer) {
  const data = buffer.getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

async function loadDemos() {
  $("#demoBtn").disabled = true;
  toast("Composing demo tracks…");
  const demos = [
    { title: "Neon Drive", artist: "MELO Demo", notes: [57, 60, 64, 67, 64, 60, 62, 65], bpm: 112, wave: "sawtooth" },
    { title: "Lo-fi Sunday", artist: "MELO Demo", notes: [60, 64, 67, 71, null, 69, 67, 64], bpm: 84, wave: "triangle" },
    { title: "Pixel Hearts", artist: "MELO Demo", notes: [72, 76, 79, 76, 74, 77, 81, 77], bpm: 128, wave: "square" },
  ];
  for (const d of demos) {
    const blob = await renderDemo(d.notes, d.bpm, d.wave);
    addTrack({ id: uid(), title: d.title, artist: d.artist, blob, liked: false, demo: true, added: Date.now() });
  }
  rebuildOrder();
  renderPlaylist();
  loadTrack(state.order[0], false);
  toast("3 demo tracks ready. Press play!");
}

// ---------- events ----------
$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
document.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

$("#playlist").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) return removeTrack(Number(remove.dataset.remove));
  const li = e.target.closest("li[data-index]");
  if (li) loadTrack(Number(li.dataset.index));
});

$("#search").addEventListener("input", (e) => { state.query = e.target.value; renderPlaylist(); });
document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
  renderPlaylist();
}));
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
  state.vizMode = b.dataset.mode;
  document.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("active", x === b));
}));

$("#demoBtn").addEventListener("click", loadDemos);
$("#playBtn").addEventListener("click", togglePlay);
$("#prevBtn").addEventListener("click", () => step(-1));
$("#nextBtn").addEventListener("click", () => step(1));
$("#shuffleBtn").addEventListener("click", setShuffle);
$("#repeatBtn").addEventListener("click", setRepeat);
$("#likeBtn").addEventListener("click", toggleLike);
$("#volume").addEventListener("input", (e) => { audio.muted = false; setVolume(Number(e.target.value)); });
$("#muteBtn").addEventListener("click", () => { audio.muted = !audio.muted; setVolume(audio.volume); });

const progress = $("#progress");
let seeking = false;
progress.addEventListener("input", () => {
  seeking = true;
  setFill(progress);
  $("#current").textContent = fmt((progress.value / 1000) * audio.duration);
});
progress.addEventListener("change", () => {
  if (isFinite(audio.duration)) audio.currentTime = (progress.value / 1000) * audio.duration;
  seeking = false;
});

audio.addEventListener("timeupdate", () => {
  if (seeking || !isFinite(audio.duration)) return;
  progress.value = (audio.currentTime / audio.duration) * 1000;
  setFill(progress);
  $("#current").textContent = fmt(audio.currentTime);
});
audio.addEventListener("loadedmetadata", () => { $("#duration").textContent = fmt(audio.duration); });
audio.addEventListener("ended", () => step(1));
audio.addEventListener("play", () => {
  $("#playBtn").textContent = "❚❚";
  $("#playBtn").setAttribute("aria-label", "Pause");
  $("#cover").classList.add("spin");
  $("#playlist").classList.remove("paused");
});
audio.addEventListener("pause", () => {
  $("#playBtn").textContent = "▶";
  $("#playBtn").setAttribute("aria-label", "Play");
  $("#cover").classList.remove("spin");
  $("#playlist").classList.add("paused");
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=search], input[type=text]")) return;
  const actions = {
    " ": togglePlay,
    ArrowRight: () => step(1),
    ArrowLeft: () => step(-1),
    ArrowUp: () => setVolume(audio.volume + 0.05),
    ArrowDown: () => setVolume(audio.volume - 0.05),
    s: setShuffle,
    r: setRepeat,
    l: toggleLike,
  };
  const fn = actions[e.key] || actions[e.key.toLowerCase()];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  audio.addEventListener("play", () => {
    const t = state.tracks[state.current];
    if (t) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: "MELO" });
  });
}

window.addEventListener("resize", resizeCanvas);

// ---------- init ----------
(async function init() {
  resizeCanvas();
  setVolume(0.8);
  draw();
  const saved = (await loadTracks()) || [];
  saved.sort((a, b) => a.added - b.added).forEach(addTrack);
  rebuildOrder();
  renderPlaylist();
  if (state.tracks.length) loadTrack(state.order[0], false);
})();
