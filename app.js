const HOUR = 36e5;
const FIVE_DAYS = 432e6;
const SAVE_KEY = "mogu-pet-v1";
const ASSET_VERSION = "11";
const STAT_LOSS_PER_HOUR = 4;

const DECOR = [
  { id: "ring", icon: "🍩", name: "甜甜圈泳圈", price: 4, className: "decor-ring" },
  { id: "ball", icon: "🏖️", name: "海灘球", price: 7, className: "decor-ball" },
  { id: "plant", icon: "🌴", name: "迷你椰子樹", price: 12, className: "decor-plant" },
  { id: "light", icon: "✨", name: "星星池燈", price: 18, className: "decor-light" },
  { id: "shell", icon: "🐚", name: "珍珠貝殼", price: 22, className: "decor-shell" },
  { id: "duck", icon: "🦆", name: "小鴨浮伴", price: 30, className: "decor-duck" },
];

const FOODS = [
  { icon: "🐟", name: "小魚", sound: "fish" },
  { icon: "🦐", name: "甜蝦", sound: "shrimp" },
  { icon: "🦑", name: "魷魚", sound: "squid" },
];

const STAGE_LABELS = ["", "纖細小海豹", "健康體型", "圓潤體型", "胖嘟嘟", "幸福圓滾滾"];
const IDLE_LINES = ["噗嚕～水溫剛剛好", "今天也想和你待在一起", "小海豹正在巡視泳池", "要不要陪我玩一下？"];
const $ = (id) => document.getElementById(id);
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const asset = (stageNumber, action = "") =>
  `assets/seal-stage-${stageNumber}${action ? `-${action}` : ""}.webp?v=${ASSET_VERSION}`;

const fresh = () => {
  const now = Date.now();
  return {
    satiety: 35,
    affection: 20,
    coins: 1000,
    lastFedAt: now,
    lastSeenAt: now,
    lastStatAt: now,
    offlineRemainderMs: 0,
    updatedAt: now,
    owned: [],
    active: [],
    dead: false,
    starterCoinsGranted: 1,
    soundOn: true,
  };
};

function normalizePet(raw) {
  const base = fresh();
  const validDecorIds = new Set(DECOR.map((item) => item.id));
  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const listOrEmpty = (value) =>
    Array.isArray(value) ? [...new Set(value.filter((id) => validDecorIds.has(id)))] : [];
  const normalized = {
    ...base,
    ...raw,
    satiety: clamp(numberOr(raw?.satiety, base.satiety)),
    affection: clamp(numberOr(raw?.affection, base.affection)),
    coins: Math.max(0, numberOr(raw?.coins, base.coins)),
    lastFedAt: numberOr(raw?.lastFedAt, base.lastFedAt),
    lastSeenAt: numberOr(raw?.lastSeenAt, base.lastSeenAt),
    lastStatAt: numberOr(raw?.lastStatAt, raw?.lastSeenAt || base.lastStatAt),
    offlineRemainderMs: Math.max(0, numberOr(raw?.offlineRemainderMs, 0)),
    updatedAt: numberOr(raw?.updatedAt, 0),
    owned: listOrEmpty(raw?.owned),
    active: listOrEmpty(raw?.active),
    dead: Boolean(raw?.dead),
    soundOn: raw?.soundOn !== false,
    starterCoinsGranted: raw?.starterCoinsGranted === 1 ? 1 : 0,
  };
  normalized.active = normalized.active.filter((id) => normalized.owned.includes(id));
  return normalized;
}

let storageAvailable = true;
let storageWarningShown = false;

function safeRead() {
  try {
    const value = localStorage.getItem(SAVE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    storageAvailable = false;
    return null;
  }
}

let pet = normalizePet(safeRead());
let mode = "home";
let currentStage = 0;
let actionActive = "";
let reactionTimer;
let interactionLock = false;
let lastPetAt = 0;
let drawerKey = "";
let decorKey = "";
let hiddenAt = 0;
let noticeTimer;
let audio;
let masterGain;
let ambientGain;
let ambientSource;
let soundUnlocked = false;
const preloaded = new Set();

function applyElapsedStats(now = Date.now()) {
  if (pet.dead) {
    pet.lastStatAt = now;
    return;
  }
  const elapsed = Math.max(0, now - pet.lastStatAt);
  if (!elapsed) return;
  const loss = (elapsed / HOUR) * STAT_LOSS_PER_HOUR;
  pet.satiety = clamp(pet.satiety - loss);
  pet.affection = clamp(pet.affection - loss);
  pet.lastStatAt = now;
  pet.dead = now - pet.lastFedAt >= FIVE_DAYS;
}

function collectOfflineCoins(elapsedMs) {
  const total = Math.max(0, elapsedMs) + pet.offlineRemainderMs;
  const earned = Math.floor(total / HOUR);
  pet.offlineRemainderMs = total % HOUR;
  pet.coins += earned;
  return earned;
}

const nowAtLoad = Date.now();
const elapsedAway = Math.max(0, nowAtLoad - pet.lastSeenAt);
const starterGift = pet.starterCoinsGranted !== 1;
applyElapsedStats(nowAtLoad);
const offlineCoins = collectOfflineCoins(elapsedAway);
if (starterGift) {
  pet.coins = Math.max(1000, pet.coins);
  pet.starterCoinsGranted = 1;
}
pet.lastSeenAt = nowAtLoad;
pet.lastStatAt = nowAtLoad;
pet.dead = pet.dead || nowAtLoad - pet.lastFedAt >= FIVE_DAYS;

function safeSave() {
  pet.lastSeenAt = Date.now();
  pet.updatedAt = Date.now();
  if (!storageAvailable) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(pet));
  } catch {
    storageAvailable = false;
    if (!storageWarningShown) {
      storageWarningShown = true;
      showNotice("這個瀏覽器暫時無法保存進度", "warning");
    }
  }
}

function stage() {
  return pet.satiety < 20 ? 1 : pet.satiety < 40 ? 2 : pet.satiety < 70 ? 3 : pet.satiety < 90 ? 4 : 5;
}

function mood() {
  if (pet.dead) return "永遠睡著了";
  if (pet.satiety < 15) return "肚子餓得沒有力氣了……";
  if (pet.satiety < 30) return "肚子咕嚕咕嚕……";
  if (pet.affection < 20) return "可以多陪陪我嗎？";
  if (pet.affection > 80 && pet.satiety > 75) return "最喜歡和你待在一起！";
  if (pet.satiety > 90) return "飽飽的，好幸福～";
  return "今天要一起玩什麼？";
}

function preloadStage(stageNumber) {
  if (preloaded.has(stageNumber) || stageNumber < 1 || stageNumber > 5) return;
  preloaded.add(stageNumber);
  ["", "walk", "eat", "pet"].forEach((action) => {
    const image = new Image();
    image.src = asset(stageNumber, action);
  });
}

function scheduleNeighborPreload(stageNumber) {
  const work = () => {
    preloadStage(stageNumber - 1);
    preloadStage(stageNumber + 1);
  };
  if ("requestIdleCallback" in window) requestIdleCallback(work, { timeout: 1800 });
  else setTimeout(work, 500);
}

function setMeterState(id, value) {
  const element = $(id);
  element.classList.toggle("is-low", value < 30);
  element.classList.toggle("is-critical", value < 15);
}

function renderStats() {
  $("coins").textContent = Math.floor(pet.coins);
  $("satiety-text").textContent = `${Math.round(pet.satiety)}%`;
  $("affection-text").textContent = `${Math.round(pet.affection)}%`;
  $("satiety-bar").style.width = `${pet.satiety}%`;
  $("affection-bar").style.width = `${pet.affection}%`;
  $("satiety-meter").setAttribute("aria-valuenow", String(Math.round(pet.satiety)));
  $("affection-meter").setAttribute("aria-valuenow", String(Math.round(pet.affection)));
  setMeterState("satiety-status", pet.satiety);
  setMeterState("affection-status", pet.affection);
}

function renderDecorations() {
  const nextKey = pet.active.join("|");
  if (nextKey === decorKey) return;
  decorKey = nextKey;
  $("decorations").innerHTML = DECOR.filter((item) => pet.active.includes(item.id))
    .map(
      (item, index) =>
        `<span class="pool-decor ${item.className}" style="--decor-delay:-${index * 0.63}s" aria-hidden="true">${item.icon}</span>`,
    )
    .join("");
}

function renderSeal() {
  const nextStage = stage();
  const roamer = $("seal-roamer");
  if (currentStage && currentStage !== nextStage) {
    roamer.classList.remove("stage-changing");
    void roamer.offsetWidth;
    roamer.classList.add("stage-changing");
    setTimeout(() => roamer.classList.remove("stage-changing"), 520);
  }
  roamer.classList.forEach((className) => {
    if (className.startsWith("stage-") && className !== "stage-changing") roamer.classList.remove(className);
  });
  roamer.classList.add(`stage-${nextStage}`);
  if (!actionActive) $("seal-art").src = asset(nextStage);
  $("seal-walk-art").src = asset(nextStage, "walk");
  $("stage-pill").textContent = STAGE_LABELS[nextStage];
  $("seal").setAttribute(
    "aria-label",
    mode === "pet" ? "摸摸小海豹，可以輕點或來回撫摸" : "和小海豹打招呼",
  );
  currentStage = nextStage;
  preloadStage(nextStage);
  scheduleNeighborPreload(nextStage);
}

function renderDrawer(force = false) {
  const key = `${mode}:${pet.owned.join(",")}:${pet.active.join(",")}:${Math.floor(pet.coins)}`;
  if (!force && key === drawerKey) return;
  drawerKey = key;
  const drawer = $("drawer");
  drawer.classList.toggle("closed", mode === "home");
  if (mode === "home") {
    drawer.innerHTML = "";
    return;
  }
  if (mode === "pet") {
    drawer.innerHTML =
      '<div class="interaction-card"><span class="big-hand" aria-hidden="true">🫳</span><div><small>摸摸時間</small><h2>輕點，或在海豹身上來回撫摸</h2><p>每次溫柔互動，好感度增加 5%</p></div></div>';
  }
  if (mode === "feed") {
    drawer.innerHTML =
      '<div class="drawer-title"><div><small>開飯啦</small><h2>今天想吃哪一個？</h2></div><span>每份 +10% 飽足度</span></div><div class="food-grid">' +
      FOODS.map(
        (food, index) =>
          `<button data-food="${index}" aria-label="餵小海豹吃${food.name}"><b aria-hidden="true">${food.icon}</b><span>${food.name}</span><small>飽足度 +10%</small></button>`,
      ).join("") +
      "</div>";
  }
  if (mode === "shop") {
    drawer.innerHTML =
      '<div class="drawer-title"><div><small>泳池小屋</small><h2>佈置舒服的家</h2></div><span>離線每滿 1 小時獲得 1 幣</span></div><div class="shop-grid">' +
      DECOR.map((item, index) => {
        const owned = pet.owned.includes(item.id);
        const active = pet.active.includes(item.id);
        return `<button data-decor="${index}" class="${active ? "is-active" : owned ? "is-owned" : ""}" aria-label="${item.name}，${owned ? (active ? "目前使用中" : "已擁有") : `${item.price} 枚海豹幣`}"><b aria-hidden="true">${item.icon}</b><span>${item.name}</span><small>${owned ? (active ? "使用中・點擊收起" : "已擁有・點擊擺上") : `🪙 ${item.price}`}</small></button>`;
      }).join("") +
      "</div>";
  }
  drawer.querySelectorAll("[data-food]").forEach((button) => {
    button.onclick = () => feed(FOODS[Number(button.dataset.food)], button);
  });
  drawer.querySelectorAll("[data-decor]").forEach((button) => {
    button.onclick = () => buy(DECOR[Number(button.dataset.decor)]);
  });
}

function render(persist = true, forceDrawer = false) {
  renderStats();
  renderSeal();
  renderDecorations();
  $("speech").textContent = mood();
  $("pool").className = `pool-scene mode-${mode}${document.hidden ? " is-paused" : ""}`;
  document.querySelectorAll(".bottom-nav button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-expanded", String(active));
  });
  $("dead-overlay").hidden = !pet.dead;
  renderDrawer(forceDrawer);
  updateSoundButton();
  if (persist) safeSave();
}

function showNotice(message, tone = "normal") {
  const notice = $("notice");
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.classList.remove("notice-pop");
  void notice.offsetWidth;
  notice.classList.add("notice-pop");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove("notice-pop"), 1900);
}

function setBusy(busy) {
  interactionLock = busy;
  $("seal").setAttribute("aria-busy", String(busy));
  document.querySelectorAll("[data-food]").forEach((button) => {
    button.disabled = busy;
  });
}

function ensureAudio(startAmbient = false) {
  if (!pet.soundOn) return null;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  if (!audio) {
    audio = new Context();
    masterGain = audio.createGain();
    const compressor = audio.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 18;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.2;
    masterGain.gain.value = 0.64;
    masterGain.connect(compressor).connect(audio.destination);
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
  soundUnlocked = true;
  if (startAmbient) startWaterAmbience();
  return audio;
}

function startWaterAmbience() {
  if (!audio || ambientSource || !pet.soundOn) return;
  const length = audio.sampleRate * 2;
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = last * 0.985 + white * 0.015;
    data[i] = last * 0.7;
  }
  ambientSource = audio.createBufferSource();
  ambientSource.buffer = buffer;
  ambientSource.loop = true;
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 850;
  ambientGain = audio.createGain();
  ambientGain.gain.value = 0.018;
  const lfo = audio.createOscillator();
  const lfoGain = audio.createGain();
  lfo.frequency.value = 0.11;
  lfoGain.gain.value = 0.006;
  lfo.connect(lfoGain).connect(ambientGain.gain);
  ambientSource.connect(filter).connect(ambientGain).connect(masterGain);
  ambientSource.start();
  lfo.start();
}

function tone(frequency, start, duration, volume, type = "sine", endFrequency = frequency) {
  if (!audio || !masterGain) return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(masterGain);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function noiseBurst(start, duration, frequency, volume, softness = 1) {
  if (!audio || !masterGain) return;
  const length = Math.max(1, Math.floor(audio.sampleRate * duration));
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const envelope = Math.pow(1 - i / length, softness);
    data[i] = (Math.random() * 2 - 1) * envelope;
  }
  const source = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = 0.72;
  gain.gain.value = volume;
  source.connect(filter).connect(gain).connect(masterGain);
  source.start(start);
}

function sound(kind, foodKind = "fish") {
  const context = ensureAudio(true);
  if (!context || !pet.soundOn) return;
  const now = context.currentTime + 0.01;
  if (kind === "select") {
    tone(360, now, 0.08, 0.035, "sine", 430);
  }
  if (kind === "pet") {
    tone(470, now, 0.2, 0.055, "sine", 590);
    tone(650, now + 0.1, 0.25, 0.045, "sine", 770);
  }
  if (kind === "coin") {
    [620, 820, 1080].forEach((frequency, index) =>
      tone(frequency, now + index * 0.07, 0.16, 0.048, "triangle", frequency * 1.08),
    );
  }
  if (kind === "decor") {
    tone(310, now, 0.11, 0.04, "triangle", 420);
    tone(510, now + 0.07, 0.16, 0.035, "sine", 620);
  }
  if (kind === "eat") {
    const profile =
      foodKind === "shrimp"
        ? { frequency: 1750, spacing: 0.12, softness: 0.7 }
        : foodKind === "squid"
          ? { frequency: 720, spacing: 0.16, softness: 1.8 }
          : { frequency: 1120, spacing: 0.145, softness: 1.1 };
    [0, profile.spacing, profile.spacing * 2].forEach((offset, index) => {
      noiseBurst(now + offset, 0.105, profile.frequency - index * 90, 0.07, profile.softness);
      tone(180 - index * 18, now + offset, 0.11, 0.025, "triangle", 125 - index * 8);
    });
    tone(145, now + profile.spacing * 2 + 0.13, 0.22, 0.035, "sine", 82);
  }
}

function updateSoundButton() {
  const button = $("sound-toggle");
  button.querySelector("span").textContent = pet.soundOn ? "🔊" : "🔇";
  button.setAttribute("aria-label", pet.soundOn ? "關閉音效" : "開啟音效");
  button.setAttribute("aria-pressed", String(!pet.soundOn));
}

function toggleSound() {
  pet.soundOn = !pet.soundOn;
  if (pet.soundOn) {
    ensureAudio(true);
    if (masterGain && audio) {
      masterGain.gain.cancelScheduledValues(audio.currentTime);
      masterGain.gain.setTargetAtTime(0.64, audio.currentTime, 0.04);
    }
    sound("select");
    showNotice("自然音效已開啟");
  } else {
    if (masterGain && audio) {
      masterGain.gain.cancelScheduledValues(audio.currentTime);
      masterGain.gain.setTargetAtTime(0.0001, audio.currentTime, 0.035);
    }
    showNotice("音效已關閉");
  }
  render(false);
  safeSave();
}

function createParticles(kind, icon) {
  const pool = $("pool");
  const sealRect = $("seal").getBoundingClientRect();
  const poolRect = pool.getBoundingClientRect();
  const count = kind === "eat" ? 5 : 7;
  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement("span");
    particle.className = `effect-particle particle-${kind}`;
    particle.textContent = kind === "eat" ? (index % 2 ? "✦" : "•") : index % 3 ? "♥" : "✦";
    particle.style.left = `${sealRect.left - poolRect.left + sealRect.width * (0.35 + Math.random() * 0.3)}px`;
    particle.style.top = `${sealRect.top - poolRect.top + sealRect.height * (0.35 + Math.random() * 0.25)}px`;
    particle.style.setProperty("--particle-x", `${(Math.random() - 0.5) * 95}px`);
    particle.style.setProperty("--particle-y", `${-45 - Math.random() * 70}px`);
    particle.style.setProperty("--particle-delay", `${index * 0.045}s`);
    particle.setAttribute("aria-hidden", "true");
    pool.appendChild(particle);
    setTimeout(() => particle.remove(), 1250);
  }
  $("reaction-icon").textContent = icon;
}

function react(kind, icon) {
  const seal = $("seal");
  const roamer = $("seal-roamer");
  actionActive = kind;
  seal.classList.remove("eat", "pet");
  void seal.offsetWidth;
  seal.classList.add(kind);
  roamer.classList.add("reacting");
  $("seal-art").src = asset(stage(), kind);
  $("reaction-icon").dataset.kind = kind;
  $("reaction-icon").hidden = false;
  createParticles(kind, icon);
  clearTimeout(reactionTimer);
  const duration = kind === "eat" ? 1480 : 1180;
  reactionTimer = setTimeout(() => {
    $("reaction-icon").hidden = true;
    seal.classList.remove(kind);
    roamer.classList.remove("reacting");
    actionActive = "";
    $("seal-art").src = asset(stage());
  }, duration);
}

function animateFood(icon, sourceButton) {
  const token = document.createElement("span");
  const sourceRect = sourceButton.getBoundingClientRect();
  const sealRect = $("seal").getBoundingClientRect();
  const transform = getComputedStyle($("seal-roamer")).transform;
  const facingRight = transform.startsWith("matrix(-");
  const startX = sourceRect.left + sourceRect.width / 2;
  const startY = sourceRect.top + sourceRect.height / 2;
  const targetX = sealRect.left + sealRect.width * (facingRight ? 0.69 : 0.31);
  const targetY = sealRect.top + sealRect.height * 0.42;
  token.className = "flying-food";
  token.textContent = icon;
  token.style.setProperty("--food-x", `${targetX - startX}px`);
  token.style.setProperty("--food-y", `${targetY - startY}px`);
  token.style.setProperty("--food-x-mid", `${(targetX - startX) * 0.86}px`);
  token.style.setProperty("--food-y-mid", `${(targetY - startY) * 0.86}px`);
  token.style.left = `${startX}px`;
  token.style.top = `${startY}px`;
  token.setAttribute("aria-hidden", "true");
  document.body.appendChild(token);
  setTimeout(() => token.remove(), 720);
}

function feed(food, sourceButton) {
  if (pet.dead || interactionLock) return;
  setBusy(true);
  animateFood(food.icon, sourceButton);
  sound("select");
  navigator.vibrate?.(8);
  showNotice(`${food.name}送到嘴邊了～`);
  const delay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 80 : 480;
  setTimeout(() => {
    pet.satiety = clamp(pet.satiety + 10);
    pet.affection = clamp(pet.affection + 1);
    pet.lastFedAt = Date.now();
    pet.dead = false;
    showNotice(`${food.name}吃光光！飽足度 +10%`, "success");
    render(true, true);
    setBusy(true);
    react("eat", food.icon);
    sound("eat", food.sound);
    navigator.vibrate?.([10, 35, 9]);
    setTimeout(() => setBusy(false), 1500);
  }, delay);
}

function addPetTrail(x, y) {
  const trail = document.createElement("span");
  trail.className = "pet-trail";
  trail.textContent = Math.random() > 0.25 ? "♥" : "✦";
  trail.style.left = `${x}px`;
  trail.style.top = `${y}px`;
  trail.setAttribute("aria-hidden", "true");
  document.body.appendChild(trail);
  setTimeout(() => trail.remove(), 700);
}

function petSeal() {
  const now = Date.now();
  if (pet.dead || mode !== "pet" || interactionLock || now - lastPetAt < 700) return;
  lastPetAt = now;
  pet.affection = clamp(pet.affection + 5);
  showNotice("摸摸成功！好感度 +5%", "success");
  render();
  react("pet", "♥");
  sound("pet");
  navigator.vibrate?.(10);
}

function greetSeal() {
  if (pet.dead || interactionLock || actionActive) return;
  const line = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
  showNotice(line);
  react("pet", "♪");
  sound("pet");
}

function buy(item) {
  if (interactionLock) return;
  if (pet.owned.includes(item.id)) {
    pet.active = pet.active.includes(item.id)
      ? pet.active.filter((id) => id !== item.id)
      : [...pet.active, item.id];
    showNotice(pet.active.includes(item.id) ? `把${item.name}擺上泳池了！` : `收起${item.name}`);
    sound("decor");
    render(true, true);
    return;
  }
  if (pet.coins < item.price) {
    showNotice("海豹幣不夠，離線休息滿一小時就會獲得 1 枚～", "warning");
    sound("select");
    return;
  }
  pet.coins -= item.price;
  pet.owned.push(item.id);
  pet.active.push(item.id);
  showNotice(`買到${item.name}了！`, "success");
  sound("coin");
  render(true, true);
}

function switchMode(nextMode) {
  mode = mode === nextMode ? "home" : nextMode;
  drawerKey = "";
  sound("select");
  render(true, true);
}

let pointerTracking = false;
let pointerTravel = 0;
let pointerLastX = 0;
let pointerLastY = 0;
let trailDistance = 0;
let gesturePetTriggered = false;
let suppressClick = false;

$("seal").addEventListener("pointerdown", (event) => {
  if (mode !== "pet" || pet.dead || interactionLock) return;
  ensureAudio(true);
  pointerTracking = true;
  pointerTravel = 0;
  trailDistance = 0;
  gesturePetTriggered = false;
  pointerLastX = event.clientX;
  pointerLastY = event.clientY;
  $("seal-roamer").classList.add("held");
  $("seal").setPointerCapture?.(event.pointerId);
});

$("seal").addEventListener("pointermove", (event) => {
  if (!pointerTracking) return;
  const distance = Math.hypot(event.clientX - pointerLastX, event.clientY - pointerLastY);
  pointerTravel += distance;
  trailDistance += distance;
  pointerLastX = event.clientX;
  pointerLastY = event.clientY;
  if (trailDistance > 22) {
    trailDistance = 0;
    addPetTrail(event.clientX, event.clientY);
  }
  if (pointerTravel > 58 && !gesturePetTriggered) {
    gesturePetTriggered = true;
    suppressClick = true;
    petSeal();
  }
});

function endPetPointer() {
  pointerTracking = false;
  $("seal-roamer").classList.remove("held");
}

$("seal").addEventListener("pointerup", endPetPointer);
$("seal").addEventListener("pointercancel", endPetPointer);
$("seal").onclick = () => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (mode === "pet") petSeal();
  else if (mode === "home") greetSeal();
};

document.querySelectorAll(".bottom-nav button").forEach((button) => {
  button.onclick = () => switchMode(button.dataset.mode);
});

$("sound-toggle").onclick = toggleSound;
$("adopt").onclick = () => {
  pet = fresh();
  mode = "home";
  currentStage = 0;
  drawerKey = "";
  decorKey = "";
  showNotice("新的小海豹來到泳池了，記得常常陪牠！", "success");
  render(true, true);
};

window.addEventListener(
  "pointerdown",
  () => {
    if (!soundUnlocked && pet.soundOn) ensureAudio(false);
  },
  { once: true, passive: true },
);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    applyElapsedStats();
    hiddenAt = Date.now();
    $("pool").classList.add("is-paused");
    safeSave();
    return;
  }
  const now = Date.now();
  applyElapsedStats(now);
  const earned = collectOfflineCoins(hiddenAt ? now - hiddenAt : 0);
  hiddenAt = 0;
  $("pool").classList.remove("is-paused");
  if (earned) showNotice(`休息期間獲得 ${earned} 枚海豹幣！`, "success");
  render();
});

window.addEventListener("pageshow", () => {
  applyElapsedStats();
  render();
});

window.addEventListener("storage", (event) => {
  if (event.key !== SAVE_KEY || !event.newValue) return;
  try {
    const incoming = normalizePet(JSON.parse(event.newValue));
    if (incoming.updatedAt <= pet.updatedAt) return;
    pet = incoming;
    currentStage = 0;
    drawerKey = "";
    decorKey = "";
    render(false, true);
    showNotice("已同步另一個分頁的照顧進度");
  } catch {
    // Ignore malformed data from another tab.
  }
});

window.addEventListener("beforeunload", () => {
  applyElapsedStats();
  safeSave();
});

setInterval(() => {
  if (document.hidden) return;
  applyElapsedStats();
  renderStats();
  if (!actionActive) $("speech").textContent = mood();
  $("dead-overlay").hidden = !pet.dead;
  safeSave();
}, 6e4);

setInterval(() => {
  if (document.hidden || actionActive || mode !== "home" || pet.dead) return;
  $("speech").textContent = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
}, 17000);

if (pet.dead) {
  $("notice").textContent = "你太久沒回來了……";
} else if (starterGift) {
  $("notice").textContent = "新手禮物：1000 枚海豹幣已送達！";
} else if (offlineCoins) {
  $("notice").textContent = `離線期間獲得 ${offlineCoins} 枚海豹幣！`;
} else {
  $("notice").textContent = "小海豹正在等你～";
}

render();
