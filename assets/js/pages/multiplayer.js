import { auth, db, rtdb } from "../firebase/config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  ref,
  set,
  onValue,
  update,
  push,
  child,
  get,
  remove,
  onDisconnect,
  onChildAdded,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
  doc,
  getDoc,
  updateDoc,
  arrayUnion,
  collection,
  query,
  where,
  getDocs,
  setDoc,
  onSnapshot,
  addDoc,
  orderBy,
  serverTimestamp,
  runTransaction as runFirestoreTransaction,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { translations } from "../data/translations.js";
import { renderNavbar } from "../components/navbar.js";
import { requireAuth } from "../auth-guard.js";
import { getRandomText } from "../data/typing-data.js";
import { saveGameScore } from "../firebase/db.js";

requireAuth();

const DEFAULT_MAX_PLAYERS = 5;
const COUNTDOWN_SECONDS = 3;
const DEFAULT_DURATION = 60;

const state = {
  mpRoomId: null,
  mpPlayerId: null,
  mpPlayersData: {},
  mpChartData: {},
  roomMaxPlayers: DEFAULT_MAX_PLAYERS,
  myElo: 1000,
  hostId: null,
  isUserReady: false,
  roomMode: "normal",
  roomStatus: "waiting",
  currentRoomText: "",
  matchDuration: DEFAULT_DURATION,
  inviteRoomId: null,
  roomUnsubscribers: [],
  roomCountdownTarget: null,
  countdownTimer: null,
  countdownTransitionTimeout: null,
  roomFinishTimeout: null,
  chartColorMap: {},
  chartColorCursor: 0,

  isTyping: false,
  isGameActive: false,
  isPlayerFinished: false,
  resultsShown: false,
  scoreSaved: false,
  text: "",
  charIndex: 0,
  mistakes: 0,
  timeLeft: 0,
  maxTime: DEFAULT_DURATION,
  timer: null,
  charSpans: [],
  latestStats: {
    wpm: 0,
    accuracy: 100,
    progress: 0,
  },

  lang: localStorage.getItem("language") || "en",
  soundEnabled: localStorage.getItem("typingSound") === "true",
  zenMode: false,
  smoothCaret: localStorage.getItem("smoothCaret") === "true",
  heatmap: {},
  heatmapEnabled: false,
  typingTimeout: null,
  friendsList: [],
};

const els = {
  lobby: document.getElementById("lobbySection"),
  game: document.getElementById("gameSection"),
  input: document.getElementById("inputField"),
  display: document.getElementById("quoteDisplay"),
  wpm: document.getElementById("wpm"),
  time: document.getElementById("timeLeft"),
  acc: document.getElementById("accuracy"),
  wrapper: document.getElementById("typingWrapper"),
  overlay: document.getElementById("focusOverlay"),
  navControls: document.querySelector(".nav-controls"),
  resultOverlay: document.getElementById("resultOverlay"),
  finalWpm: document.getElementById("finalWpm"),
  finalAcc: document.getElementById("finalAcc"),
  finalTime: document.getElementById("finalTime"),
  finalLeaderboard: document.getElementById("finalLeaderboard"),
  matchMeta: document.getElementById("matchMeta"),
  readySummary: document.getElementById("readySummary"),
  raceTrack: document.getElementById("raceTrack"),
  miniRoomEvents: document.getElementById("miniRoomEvents"),
  countdownOverlay: document.getElementById("countdownOverlay"),
  countdownNumber: document.getElementById("countdownNumber"),
  gameStatusBadge: document.getElementById("gameStatusBadge"),
  btnCopyRoomCodeResult: document.getElementById("btnCopyRoomCodeResult"),
};

document.addEventListener("DOMContentLoaded", () => {
  initStars();
  renderNavbar();
  renderLobby();
  applyGlobalLanguage(state.lang);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    state.mpPlayerId = user.uid;
    await loadUserProfile();

    if (state.inviteRoomId && !state.mpRoomId) {
      joinRoom(state.inviteRoomId);
    }
  });

  if (els.input) els.input.addEventListener("input", handleTyping);

  if (els.wrapper) {
    els.wrapper.addEventListener("click", () => {
      if (!state.isGameActive || state.isPlayerFinished) return;
      els.input.focus();
    });
  }

  if (els.overlay) {
    els.overlay.addEventListener("click", () => {
      if (!state.isGameActive || state.isPlayerFinished) return;
      els.input.focus();
      els.overlay.classList.add("hidden");
    });
  }

  if (els.input) {
    els.input.addEventListener("blur", () => {
      if (
        els.game.style.display !== "none" &&
        state.isGameActive &&
        !state.isPlayerFinished
      ) {
        els.overlay.classList.remove("hidden");
      }
    });
  }

  if (els.btnCopyRoomCodeResult) {
    els.btnCopyRoomCodeResult.onclick = copyInviteLink;
  }

  const leaveBtn = document.querySelector('button[title="Leave Match"]');
  if (leaveBtn) {
    leaveBtn.onclick = async (e) => {
      e.preventDefault();
      await leaveCurrentRoom();
      location.reload();
    };
  }

  window.addEventListener("beforeunload", () => {
    if (state.mpRoomId && state.mpPlayerId) {
      try {
        remove(ref(rtdb, `rooms/${state.mpRoomId}/players/${state.mpPlayerId}`));
        remove(ref(rtdb, `rooms/${state.mpRoomId}/typing/${state.mpPlayerId}`));
      } catch (_) {}
    }
  });

  setupControls();
  checkInviteLink();
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

function getDurationLabel(duration) {
  if (duration >= 60 && duration % 60 === 0) {
    const minutes = duration / 60;
    return `${minutes} min`;
  }
  return `${duration}s`;
}

function getModeLabel(mode) {
  const t = translations[state.lang] || translations.en;
  return mode === "ranked"
    ? t.modeRanked || "Ranked"
    : t.modeNormal || "Normal";
}

function getSelectedDuration() {
  const select = document.getElementById("matchDurationSelect");
  const value = parseInt(select?.value || DEFAULT_DURATION, 10);
  return Number.isFinite(value) ? value : DEFAULT_DURATION;
}

function isMobileDevice() {
  try {
    return (
      /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(
        navigator.userAgent,
      ) ||
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
    );
  } catch (e) {
    return false;
  }
}

function setupControls() {
  const btnSound = document.getElementById("btnSound");
  if (btnSound) btnSound.onclick = toggleSound;

  if (els.navControls && !document.getElementById("btnZen")) {
    const zenBtn = document.createElement("button");
    zenBtn.id = "btnZen";
    zenBtn.className = "nav-control-btn";
    zenBtn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i> Zen Mode';
    zenBtn.onclick = toggleZenMode;

    const heatBtn = document.createElement("button");
    heatBtn.id = "btnHeatmap";
    heatBtn.className = "nav-control-btn";
    heatBtn.innerHTML = '<i class="fas fa-fire-alt"></i> Heatmap Off';
    heatBtn.onclick = toggleHeatmap;

    els.navControls.insertBefore(heatBtn, els.navControls.firstChild);
    els.navControls.insertBefore(zenBtn, els.navControls.firstChild);
  }

  updateControlButtons();
}

function checkInviteLink() {
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get("room");

  if (!roomId) return;

  state.inviteRoomId = roomId;
  const roomInput = document.getElementById("roomInput");
  if (roomInput) roomInput.value = roomId;

  if (auth.currentUser && !state.mpRoomId) {
    joinRoom(roomId);
  }
}

function renderLobby() {
  const t = translations[state.lang] || translations.en;

  els.lobby.innerHTML = `
    <div class="dashboard-layout">
      <div class="dashboard-main">
        <!-- ARENA HEADER BANNER -->
        <div class="arena-hero-banner">
          <div class="arena-hero-badge">
            <span class="pulse-dot"></span>
            <span>MULTIPLAYER ARENA // SEASON 2026</span>
          </div>
          <h1 class="arena-title">LIVE COMPETITIVE <span>TYPING</span></h1>
          <p class="arena-subtitle">Test your speed against racers worldwide in real time. Climb the ELO ladder or scrim with rivals.</p>
        </div>

        <!-- PLAY MODES HERO CARDS -->
        <div class="play-options">
          <div class="play-card mode-quick" id="btnQuickMatch" role="button" tabindex="0">
            <div class="play-card-glow"></div>
            <div class="play-card-head">
              <span class="mode-tag quick"><i class="fas fa-bolt"></i> CASUAL / SCRIM</span>
              <span class="mode-status live"><i class="fas fa-circle"></i> INSTANT</span>
            </div>
            <div class="play-card-core">
              <div class="play-card-icon quick">
                <i class="fas fa-bolt"></i>
              </div>
              <div class="play-card-details">
                <h3>${t.btnQuickMatch || "Quick Match"}</h3>
                <p>Instant drop-in matchmaking. Battle 2-5 racers in standard open queue.</p>
              </div>
            </div>
            <div class="play-card-footer">
              <span class="queue-info"><i class="fas fa-users"></i> 2-5 Racers</span>
              <span class="play-action-btn">QUEUE NOW <i class="fas fa-arrow-right"></i></span>
            </div>
          </div>

          <div class="play-card mode-ranked ranked" id="btnRanked" role="button" tabindex="0">
            <div class="play-card-glow ranked"></div>
            <div class="play-card-head">
              <span class="mode-tag ranked"><i class="fas fa-trophy"></i> COMPETITIVE 1V1</span>
              <span class="mode-status rated"><i class="fas fa-medal"></i> MMR RATED</span>
            </div>
            <div class="play-card-core">
              <div class="play-card-icon ranked">
                <i class="fas fa-trophy"></i>
              </div>
              <div class="play-card-details">
                <h3>${t.btnRanked || "Ranked 1v1"}</h3>
                <p>High-stakes duel. Gain or lose official ELO rating on the global leaderboard.</p>
              </div>
            </div>
            <div class="play-card-footer">
              <span class="queue-info"><i class="fas fa-shield-alt"></i> Official MMR</span>
              <span class="play-action-btn ranked">RANKED MATCH <i class="fas fa-arrow-right"></i></span>
            </div>
          </div>
        </div>

        <!-- CUSTOM SCRIM & PRIVATE ROOM SECTION -->
        <div class="custom-room-section">
          <div class="custom-room-header">
            <div class="crh-title">
              <i class="fas fa-sliders-h"></i>
              <span>CUSTOM SCRIM ROOMS</span>
            </div>
            <div class="crh-subtitle">Host or join a custom match with friends</div>
          </div>

          <div class="room-actions-bar">
            <div class="room-settings-cluster">
              <div class="setting-field">
                <label for="matchDurationSelect"><i class="fas fa-stopwatch"></i> DURATION</label>
                <select id="matchDurationSelect" class="sleek-input select-styled">
                  <option value="30">30s Blitz</option>
                  <option value="60" selected>60s Standard</option>
                  <option value="120">120s Endurance</option>
                </select>
              </div>
              <div class="setting-field">
                <label for="maxPlayersSelect"><i class="fas fa-user-friends"></i> MAX RACERS</label>
                <select id="maxPlayersSelect" class="sleek-input select-styled">
                  <option value="2">2 Players (1v1)</option>
                  <option value="3">3 Players</option>
                  <option value="4">4 Players</option>
                  <option value="5" selected>5 Players</option>
                </select>
              </div>
            </div>

            <div class="room-controls-cluster">
              <button class="sleek-btn primary-btn" id="btnCreateRoom">
                <i class="fas fa-plus-circle"></i> Create Room
              </button>
              <div class="room-cluster-divider"></div>
              <div class="join-box">
                <div class="join-input-wrap">
                  <i class="fas fa-key join-icon"></i>
                  <input type="text" id="roomInput" class="sleek-input" placeholder="Room ID..." />
                </div>
                <button class="sleek-btn outline" id="btnJoinRoom">
                  <i class="fas fa-sign-in-alt"></i> Join
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ACTIVE ROOM IN-LOBBY CONTAINER -->
        <div id="mpRoomInfo" class="room-info-container" style="display:none;">
          <div class="room-header-sleek">
            <div class="room-title">
              <div class="room-eyebrow">ACTIVE MATCHROOM</div>
              <div class="room-title-row">
                <h2>ROOM <span id="roomIdDisplay" class="highlight"></span></h2>
                <div id="roomModeBadge" class="badge"></div>
              </div>
            </div>
            <div class="room-header-actions">
              <span id="lobbyStatusValue" class="status-text">Waiting</span>
              <button class="sleek-btn outline small" id="btnInvite">
                <i class="fas fa-link"></i> Invite Link
              </button>
            </div>
          </div>
          
          <div class="room-roster-header">
            <span class="roster-title"><i class="fas fa-users"></i> LOBBY ROSTER</span>
            <span class="roster-ready-metric"><span id="roomReadyCount">0/${state.roomMaxPlayers}</span> Ready</span>
          </div>

          <div class="room-players-grid" id="playerList"></div>
          
          <div class="room-footer-sleek">
            <div class="room-summary">
              <p id="waitingMsg" class="waiting-msg">${t.lblWaiting || "Waiting for racers to get ready..."}</p>
            </div>
            <div class="room-controls">
              <button class="sleek-btn ready-btn" id="btnReady">${t.btnReady || "Ready"}</button>
              <button class="sleek-btn success start-btn" id="btnStartMatch" style="display:none;">
                <i class="fas fa-play"></i> ${t.btnStartMatch || "Start Match"}
              </button>
            </div>
          </div>

          <!-- TACTICAL IN-ROOM CHAT -->
          <div class="sleek-chat">
            <div class="chat-header-bar">
              <i class="fas fa-comments"></i>
              <span>ROOM CHAT</span>
            </div>
            <div class="chat-messages" id="chatMessages"></div>
            <div class="chat-input-wrapper">
              <input type="text" id="chatInput" placeholder="${t.placeholderChat || "Message room..."}" class="sleek-input" />
              <button id="btnSendChat" class="icon-btn" title="Send message"><i class="fas fa-paper-plane"></i></button>
            </div>
            <div id="typingIndicator" class="typing-indicator"></div>
          </div>
        </div>
      </div>

      <aside class="dashboard-sidebar">
        <!-- USER RANK WIDGET -->
        <div class="user-rank-widget">
          <div class="rank-header">
            <span class="rank-title"><i class="fas fa-trophy"></i> COMPETITIVE MMR</span>
            <span id="myEloValue" class="elo-value">${state.myElo || 1000} ELO</span>
          </div>
          <div id="myRankBadge" class="rank-badge-display">
            ${getRankBadgeHTML(state.myElo || 1000)}
          </div>
          <div class="rank-chart-wrapper">
            <div class="rank-chart-label">RATING TRAJECTORY</div>
            <canvas id="mobaRankChart"></canvas>
          </div>
        </div>

        <!-- FRIENDS & RIVALS WIDGET -->
        <div class="friends-widget">
          <div class="sidebar-header">
            <h3><i class="fas fa-user-friends"></i> FRIENDS & RIVALS</h3>
            <span id="myShortId" class="short-id">ID: ...</span>
          </div>
          <div class="add-friend-bar">
            <input type="text" id="friendIdInput" placeholder="Enter Friend ID..." class="sleek-input small">
            <button id="btnAddFriend" class="icon-btn" title="Add Friend"><i class="fas fa-user-plus"></i></button>
          </div>
          <div class="friends-list" id="friendsList"></div>
        </div>
        
        <!-- DIRECT PEER MESSAGING PANEL -->
        <div class="friend-chat-panel" id="friendChatPanel" style="display:none;">
          <div class="friend-chat-header">
            <div class="friend-chat-info">
              <div id="friendChatTitle" class="friend-chat-title">Chat</div>
              <div id="friendChatSubtitle" class="friend-chat-subtitle" style="display:none;"></div>
            </div>
            <button id="btnCloseFriendChat" class="icon-btn small" title="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="friend-chat-messages" id="friendChatMessages"></div>
          <div class="chat-input-wrapper">
            <input type="text" id="friendChatInput" placeholder="Direct message..." class="sleek-input small">
            <button id="btnSendFriendChat" class="icon-btn small" title="Send"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
      </aside>
    </div>
  `;

  document.getElementById("btnCreateRoom").onclick = () => {
    const maxP =
      parseInt(document.getElementById("maxPlayersSelect").value, 10) ||
      DEFAULT_MAX_PLAYERS;
    createRoom("normal", getSelectedDuration(), maxP);
  };

  document.getElementById("btnQuickMatch").onclick = () =>
    findMatch("normal", getSelectedDuration(), 2);
  document.getElementById("btnRanked").onclick = () =>
    findMatch("ranked", getSelectedDuration(), 2);

  document.getElementById("btnJoinRoom").onclick = () => {
    const rid = document.getElementById("roomInput").value.trim();
    if (!rid) {
      alert(t.placeholderRoomID || "Please enter a Room ID!");
      return;
    }
    joinRoom(rid);
  };

  document.getElementById("btnStartMatch").onclick = startMultiplayerGame;
  document.getElementById("btnReady").onclick = toggleReady;
  document.getElementById("btnAddFriend").onclick = addFriend;
  document.getElementById("btnSendChat").onclick = sendChat;
  document.getElementById("btnInvite").onclick = copyInviteLink;

  const chatInput = document.getElementById("chatInput");
  if (chatInput) {
    chatInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") sendChat();
    });
    chatInput.addEventListener("input", handleChatTyping);
  }

  const btnSendFriendChat = document.getElementById("btnSendFriendChat");
  if (btnSendFriendChat) btnSendFriendChat.onclick = sendFriendMessage;

  const btnCloseFriendChat = document.getElementById("btnCloseFriendChat");
  if (btnCloseFriendChat) btnCloseFriendChat.onclick = closeFriendChat;

  const friendChatInput = document.getElementById("friendChatInput");
  if (friendChatInput) {
    friendChatInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") sendFriendMessage();
    });
  }

  if (state.inviteRoomId) {
    const roomInput = document.getElementById("roomInput");
    if (roomInput) roomInput.value = state.inviteRoomId;
  }

  loadUserProfile();
  updateLobbyStatusLabel("Ready to queue");
}

function updateLobbyStatusLabel(text) {
  const el = document.getElementById("lobbyStatusValue");
  if (el) el.textContent = text;
}

function resetRoomSubscriptions() {
  state.roomUnsubscribers.forEach((unsubscribe) => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("Room unsubscribe error", error);
    }
  });

  state.roomUnsubscribers = [];
  clearInterval(state.countdownTimer);
  clearTimeout(state.countdownTransitionTimeout);
  clearTimeout(state.roomFinishTimeout);
  state.roomCountdownTarget = null;
}

let isMigratingHost = false;
async function migrateHost(roomId, remainingUids) {
  if (isMigratingHost || !roomId || !remainingUids || remainingUids.length === 0) return;
  isMigratingHost = true;
  try {
    const hostRef = ref(rtdb, `rooms/${roomId}/host`);
    await runTransaction(hostRef, (currentHost) => {
      // If currentHost was already migrated to an active player, keep it
      if (currentHost && remainingUids.includes(currentHost)) {
        return currentHost;
      }
      // Deterministically elect the first UID in sorted order
      const sorted = [...remainingUids].sort();
      return sorted[0] || null;
    });
  } catch (error) {
    console.warn("Host migration transaction error:", error);
  } finally {
    isMigratingHost = false;
  }
}

async function leaveCurrentRoom() {
  const roomId = state.mpRoomId;
  const playerId = state.mpPlayerId || auth.currentUser?.uid;

  if (roomId && playerId) {
    try {
      try {
        await onDisconnect(ref(rtdb, `rooms/${roomId}/players/${playerId}`)).cancel();
        await onDisconnect(ref(rtdb, `rooms/${roomId}/typing/${playerId}`)).cancel();
      } catch (_) {}

      await remove(ref(rtdb, `rooms/${roomId}/players/${playerId}`));
      await remove(ref(rtdb, `rooms/${roomId}/typing/${playerId}`));
    } catch (err) {
      console.warn("Error leaving room:", err);
    }
  }

  if (syncThrottleTimer) {
    clearTimeout(syncThrottleTimer);
    syncThrottleTimer = null;
  }
  pendingSyncPayload = null;

  resetRoomSubscriptions();

  state.mpRoomId = null;
  state.mpPlayerId = null;
  state.hostId = null;
  state.isUserReady = false;
  state.roomStatus = "waiting";
  state.mpPlayersData = {};
  state.isGameActive = false;
  state.isPlayerFinished = false;

  const mpRoomInfo = document.getElementById("mpRoomInfo");
  if (mpRoomInfo) {
    mpRoomInfo.classList.remove("active");
    mpRoomInfo.style.display = "none";
  }
  updateReadyButtonUI();
  updateRoomActionVisibility();
}

function copyInviteLink() {
  if (!state.mpRoomId) return;

  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${state.mpRoomId}`;
  navigator.clipboard
    .writeText(inviteUrl)
    .then(() => {
      const t = translations[state.lang] || translations.en;
      showToast(t.msgLinkCopied || "Link copied to clipboard!", "success");
    })
    .catch(() => {
      const t = translations[state.lang] || translations.en;
      showToast(t.msgLinkCopyFailed || "Unable to copy invite link.", "error");
    });
}

async function findMatch(mode, duration, maxPlayers = 2) {
  const user = auth.currentUser;
  if (!user) return alert("Please login first!");

  const t = translations[state.lang] || translations.en;
  const btnId = mode === "ranked" ? "btnRanked" : "btnQuickMatch";
  const btn = document.getElementById(btnId);
  const originalText = btn ? btn.innerHTML : "";

  if (btn) {
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t.lblSearching || "Searching..."}`;
    btn.disabled = true;
  }

  updateLobbyStatusLabel(`Searching ${getModeLabel(mode)} room...`);

  try {
    const roomsRef = ref(rtdb, "rooms");
    const snapshot = await get(roomsRef);
    const rooms = snapshot.val() || {};

    let foundRoomId = null;

    for (const [id, room] of Object.entries(rooms)) {
      const playerCount = room.players ? Object.keys(room.players).length : 0;
      const sameDuration =
        parseInt(room.duration || DEFAULT_DURATION, 10) === duration;
      const sameMaxPlayers =
        parseInt(room.maxPlayers || DEFAULT_MAX_PLAYERS, 10) === maxPlayers;

      if (
        room.status === "waiting" &&
        room.mode === mode &&
        sameDuration &&
        sameMaxPlayers &&
        playerCount < maxPlayers
      ) {
        foundRoomId = id;
        break;
      }
    }

    if (foundRoomId) {
      await joinRoom(foundRoomId);
      if (state.mpRoomId !== foundRoomId) {
        await createRoom(mode, duration, maxPlayers);
      }
    } else {
      await createRoom(mode, duration, maxPlayers);
    }
  } catch (error) {
    console.error(error);
    alert("Error finding match");
    updateLobbyStatusLabel("Search failed");
  } finally {
    if (btn) {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }
}

async function createRoom(
  mode = "normal",
  duration = DEFAULT_DURATION,
  maxPlayers = DEFAULT_MAX_PLAYERS,
) {
  const user = auth.currentUser;
  if (!user) return;

  if (state.mpRoomId) {
    await leaveCurrentRoom();
  }

  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const text = getRandomText("timetest", null, state.lang);

  state.mpRoomId = roomId;
  state.mpPlayerId = user.uid;
  state.roomMode = mode;
  state.roomMaxPlayers = maxPlayers;
  state.matchDuration = duration;
  state.currentRoomText = text;
  state.roomStatus = "waiting";

  const roomRef = ref(rtdb, `rooms/${roomId}`);

  await set(roomRef, {
    host: user.uid,
    status: "waiting",
    mode,
    duration,
    maxPlayers,
    text,
    createdAt: Date.now(),
  });
  await joinRoom(roomId);
}

async function joinRoom(roomId) {
  const user = auth.currentUser;
  if (!user) {
    alert("Please login first!");
    return;
  }

  const previousRoomId =
    state.mpRoomId && state.mpRoomId !== roomId ? state.mpRoomId : null;

  const t = translations[state.lang] || translations.en;
  updateLobbyStatusLabel("Joining room...");

  try {
    const roomRef = ref(rtdb, `rooms/${roomId}`);
    const roomSnapshot = await get(roomRef);

    if (!roomSnapshot.exists()) {
      alert(t.msgRoomNotFound || "Room not found!");
      updateLobbyStatusLabel("Room not found");
      return;
    }

    const roomData = roomSnapshot.val() || {};
    const maxPlayers = parseInt(
      roomData.maxPlayers || DEFAULT_MAX_PLAYERS,
      10,
    );
    state.roomMaxPlayers = maxPlayers;

    if (roomData.status !== "waiting" && !roomData.players?.[user.uid]) {
      alert(t.msgRoomStarted || "This match has already started.");
      updateLobbyStatusLabel("Room already started");
      return;
    }

    const currentPlayers = roomData.players || {};
    const playerCount = Object.keys(currentPlayers).length;

    if (playerCount >= maxPlayers && !currentPlayers[user.uid]) {
      alert(t.msgRoomFull || "Room is full!");
      updateLobbyStatusLabel("Room full");
      return;
    }

    const playerRef = ref(rtdb, `rooms/${roomId}/players/${user.uid}`);
    const initialPlayerData = {
      name: user.displayName || "Guest",
      photoURL:
        user.photoURL ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || "Guest")}&background=random`,
      progress: currentPlayers[user.uid]?.progress || 0,
      isReady: Boolean(currentPlayers[user.uid]?.isReady),
      wpm: 0,
      accuracy: 100,
      isFinished: false,
      finishedAt: null,
      elo: state.myElo || 1000,
    };

    try {
      await set(playerRef, initialPlayerData);
    } catch (writeErr) {
      console.warn("Join failed or room became full:", writeErr);
      alert(t.msgRoomFull || "Could not join room (room may be full)!");
      updateLobbyStatusLabel("Join failed");
      return;
    }

    if (previousRoomId) {
      try {
        await remove(ref(rtdb, `rooms/${previousRoomId}/players/${user.uid}`));
        await remove(ref(rtdb, `rooms/${previousRoomId}/typing/${user.uid}`));
      } catch (err) {
        console.warn("Cleanup previous room failed:", err);
      }
    }

    resetRoomSubscriptions();

    state.mpRoomId = roomId;
    state.mpPlayerId = user.uid;
    state.isUserReady = Boolean(initialPlayerData.isReady);
    state.hostId = roomData.host || user.uid;
    state.roomMode = roomData.mode || "normal";
    state.matchDuration = parseInt(roomData.duration || DEFAULT_DURATION, 10);
    state.currentRoomText =
      roomData.text || getRandomText("timetest", null, state.lang);
    state.roomStatus = roomData.status || "waiting";
    state.resultsShown = false;
    state.scoreSaved = false;

    const playerRef = ref(rtdb, `rooms/${roomId}/players/${user.uid}`);
    onDisconnect(playerRef).remove();
    onDisconnect(ref(rtdb, `rooms/${roomId}/typing/${user.uid}`)).remove();

    const mpRoomInfo = document.getElementById("mpRoomInfo");
    if (mpRoomInfo) {
      mpRoomInfo.classList.add("active");
      mpRoomInfo.style.display = "flex";
    }

    const roomIdDisplay = document.getElementById("roomIdDisplay");
    if (roomIdDisplay) roomIdDisplay.innerText = roomId;

    renderRoomBadge();
    updateReadyButtonUI();
    updateRoomActionVisibility();
    updateMatchMeta();
    updateLobbyStatusLabel(`Joined room ${roomId}`);

    setupRoomListeners(roomId);
  } catch (error) {
    console.error("Error joining room:", error);
    alert(t.msgRoomNotFound || "Error joining room!");
    updateLobbyStatusLabel("Join failed");
  }
}

function renderRoomBadge() {
  const badge = document.getElementById("roomModeBadge");
  if (!badge) return;

  const color = state.roomMode === "ranked" ? "#facc15" : "#38bdf8";
  badge.innerHTML = `
    <span class="mode-dot" style="background:${color}"></span>
    ${escapeHtml(getModeLabel(state.roomMode))} · ${escapeHtml(getDurationLabel(state.matchDuration))}
  `;
  badge.style.color = color;
  badge.style.border = `1px solid ${color}`;
}

function setupRoomListeners(roomId) {
  const roomUnsub = onValue(ref(rtdb, `rooms/${roomId}`), (snapshot) => {
    const room = snapshot.val();

    if (!room) {
      showToast("Room closed.", "error");
      setTimeout(() => location.reload(), 600);
      return;
    }

    state.hostId = room.host || state.hostId;
    state.roomMode = room.mode || state.roomMode;
    state.matchDuration = parseInt(
      room.duration || state.matchDuration || DEFAULT_DURATION,
      10,
    );
    state.currentRoomText = room.text || state.currentRoomText;
    state.roomStatus = room.status || "waiting";

    renderRoomBadge();
    updateRoomActionVisibility();
    updateMatchMeta();
    renderMiniRoomSnapshot();

    if (room.status === "countdown") {
      startRoomCountdown(room);
    } else if (room.status === "playing") {
      hideCountdown();
      if (!state.isGameActive) {
        startGame(room.text || state.currentRoomText, state.matchDuration);
      }
    } else if (room.status === "finished") {
      hideCountdown();
      finalizeRoomResults();
    }
  });

  const playersUnsub = onValue(
    ref(rtdb, `rooms/${roomId}/players`),
    (snapshot) => {
      const players = snapshot.val() || {};

      if (state.mpRoomId && !players[state.mpPlayerId]) {
        const t = translations[state.lang] || translations.en;
        alert(t.msgKicked || "You have been kicked!");
        location.reload();
        return;
      }

      state.mpPlayersData = players;

      // Automatically migrate host if current host disconnected/left
      if (state.hostId && !players[state.hostId]) {
        const remainingUids = Object.keys(players);
        if (remainingUids.length > 0) {
          migrateHost(roomId, remainingUids);
        }
      }

      state.isUserReady = Boolean(players[state.mpPlayerId]?.isReady);
      renderPlayerList(players);
      renderRaceTrack(players);
      renderMiniRoomSnapshot();
      updateReadySummary(players);
      maybeFinishRoom(players);
    },
  );

  const chatUnsub = onChildAdded(
    ref(rtdb, `rooms/${roomId}/chat`),
    (snapshot) => {
      const msg = snapshot.val();
      appendChatMessage(msg.user, msg.text, msg.timestamp);
    },
  );

  state.roomUnsubscribers.push(roomUnsub, playersUnsub, chatUnsub);
  setupTypingListener(roomId);
}

function updateRoomActionVisibility() {
  const startBtn = document.getElementById("btnStartMatch");
  const waitingMsg = document.getElementById("waitingMsg");
  const currentUid = auth.currentUser?.uid;
  const isHost = state.hostId === currentUid;
  const totalPlayers = Object.keys(state.mpPlayersData || {}).length;
  // require at least 2 players to start a multiplayer match
  const canStart =
    isHost && state.roomStatus === "waiting" && totalPlayers >= 2;
  if (startBtn) startBtn.style.display = canStart ? "inline-flex" : "none";
  if (waitingMsg) {
    waitingMsg.style.display = canStart ? "none" : "block";
    const t = translations[state.lang] || translations.en;
    waitingMsg.textContent =
      state.roomStatus === "countdown"
        ? t.lblCountdown || "Countdown started..."
        : state.roomStatus === "playing"
          ? t.lblInProgress || "Match in progress..."
          : state.roomStatus === "finished"
            ? t.lblFinished || "Match finished."
            : t.lblWaiting || "Waiting for host...";
  }

  updateReadyButtonUI();
}

function updateMatchMeta() {
  if (!els.matchMeta) return;

  const totalPlayers = Object.keys(state.mpPlayersData || {}).length;
  const currentUid = auth.currentUser?.uid;
  const isHost = state.hostId === currentUid;

  els.matchMeta.innerHTML = `
    <span class="meta-pill"><i class="fas fa-layer-group"></i> ${escapeHtml(getModeLabel(state.roomMode))}</span>
    <span class="meta-pill"><i class="fas fa-stopwatch"></i> ${escapeHtml(getDurationLabel(state.matchDuration))}</span>
    <span class="meta-pill"><i class="fas fa-user-friends"></i> ${totalPlayers}/${state.roomMaxPlayers}</span>
    <span class="meta-pill"><i class="fas fa-${isHost ? "crown" : "user"}"></i> ${isHost ? "Host" : "Player"}</span>
  `;
}

function updateReadySummary(players = state.mpPlayersData) {
  const list = Object.values(players || {});
  const readyCount = list.filter((player) => player.isReady).length;
  const totalCount = list.length;

  const roomReadyCount = document.getElementById("roomReadyCount");
  if (roomReadyCount)
    roomReadyCount.innerText = `${readyCount}/${state.roomMaxPlayers}`;

  if (els.readySummary) {
    els.readySummary.innerText = `${readyCount}/${totalCount || 0} ready`;
  }

  const roomDurationValue = document.getElementById("roomDurationValue");
  if (roomDurationValue)
    roomDurationValue.innerText = getDurationLabel(state.matchDuration);
}

function getSortedPlayers(players = state.mpPlayersData) {
  return Object.entries(players || {})
    .map(([uid, player]) => ({ uid, ...player }))
    .sort((a, b) => {
      if (Number(Boolean(b.isFinished)) !== Number(Boolean(a.isFinished))) {
        return Number(Boolean(b.isFinished)) - Number(Boolean(a.isFinished));
      }

      if ((b.progress || 0) !== (a.progress || 0)) {
        return (b.progress || 0) - (a.progress || 0);
      }

      if ((b.wpm || 0) !== (a.wpm || 0)) {
        return (b.wpm || 0) - (a.wpm || 0);
      }

      return (a.finishedAt || Infinity) - (b.finishedAt || Infinity);
    });
}

function getRankBadgeHTML(elo) {
  const t = translations[state.lang] || translations.en;
  if (!elo) elo = 1000;
  if (elo < 1200)
    return `<span class="rank-badge rank-bronze">${t.rankBronze || "Bronze"}</span>`;
  if (elo < 1400)
    return `<span class="rank-badge rank-silver">${t.rankSilver || "Silver"}</span>`;
  if (elo < 1600)
    return `<span class="rank-badge rank-gold">${t.rankGold || "Gold"}</span>`;
  if (elo < 2000)
    return `<span class="rank-badge rank-diamond">${t.rankDiamond || "Diamond"}</span>`;
  return `<span class="rank-badge rank-master">${t.rankMaster || "Master"}</span>`;
}

function renderPlayerList(players) {
  const list = document.getElementById("playerList");
  if (!list) return;

  const currentUid = auth.currentUser?.uid;
  const isHost = state.hostId === currentUid;
  const playerArray = Object.entries(players || {});
  let html = "";

  for (let i = 0; i < state.roomMaxPlayers; i++) {
    if (i < playerArray.length) {
      const [uid, player] = playerArray[i];
      const isPlayerHost = state.hostId === uid;
      const isCurrentUser = currentUid === uid;
      const progress = Math.max(0, Math.min(100, player.progress || 0));
      const rankBadge = player.elo ? getRankBadgeHTML(player.elo) : "";

      html += `
        <div class="sleek-player-card ${isPlayerHost ? "host" : ""} ${isCurrentUser ? "me" : ""}">
          ${
            isHost && uid !== currentUid && state.roomStatus === "waiting"
              ? `<button class="kick-btn" onclick="kickPlayer('${uid}')" title="Kick Player"><i class="fas fa-times"></i></button>`
              : ""
          }
          <div class="sp-avatar-wrap">
            <img src="${escapeHtml(player.photoURL || "")}" class="sp-avatar" alt="Avatar" onerror="this.src='../assets/images/default-avatar.png'">
            ${isPlayerHost ? '<div class="sp-host-badge" title="Room Host"><i class="fas fa-crown"></i></div>' : ""}
          </div>
          <div class="sp-info">
            <div class="sp-name-row">
              <span class="sp-name">${escapeHtml(player.name || "Guest")}</span>
              ${isCurrentUser ? '<span class="sp-you-badge">YOU</span>' : ""}
            </div>
            <div class="sp-meta-row">
              <span class="sp-rank-slot">${rankBadge}</span>
              <span class="sp-stats">${player.wpm || 0} WPM · ${player.accuracy || 100}%</span>
            </div>
            <div class="sp-progress-bar"><div class="sp-progress-fill" style="width:${progress}%"></div></div>
          </div>
          <div class="sp-status ${player.isReady ? "ready" : "waiting"}">
            ${player.isFinished ? '<span class="status-pill finished"><i class="fas fa-flag-checkered"></i> Done</span>' : player.isReady ? '<span class="status-pill ready"><i class="fas fa-check"></i> Ready</span>' : '<span class="status-pill waiting"><i class="fas fa-hourglass-half"></i> Wait</span>'}
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="sleek-player-card empty">
          <div class="sp-avatar-wrap empty"><i class="fas fa-user-plus"></i></div>
          <div class="sp-info">
            <div class="sp-name empty">Open Slot</div>
            <div class="sp-slot-sub">Waiting for challenger...</div>
          </div>
        </div>
      `;
    }
  }

  list.innerHTML = html;
}

function renderRaceTrack(players) {
  if (!els.raceTrack) return;

  const sorted = getSortedPlayers(players);
  const currentUid = auth.currentUser?.uid;

  if (!sorted.length) {
    els.raceTrack.innerHTML = `<div class="empty-race-state"><i class="fas fa-spinner fa-spin"></i> Initializing race track...</div>`;
    return;
  }

  els.raceTrack.innerHTML = sorted
    .map((player, index) => {
      const progress = Math.max(0, Math.min(100, player.progress || 0));
      const isMe = player.uid === currentUid;
      return `
        <div class="race-lane ${isMe ? "me" : ""}">
          <div class="lane-player-block">
            <span class="lane-pos">#${index + 1}</span>
            <div class="lane-player">${escapeHtml(player.name || "Guest")}</div>
            ${isMe ? '<span class="lane-you-tag">YOU</span>' : ""}
          </div>
          <div class="lane-track">
            <div class="lane-progress" style="width:${progress}%"></div>
            <div class="lane-car" style="left:${progress}%">
              <div class="lane-avatar-wrap">
                <img src="${escapeHtml(player.photoURL || "")}" class="lane-avatar" onerror="this.src='../assets/images/default-avatar.png'">
              </div>
              <div class="lane-wpm-badge">
                <span class="lane-wpm">${player.wpm || 0}</span>
                <span class="lane-unit">WPM</span>
              </div>
            </div>
            <div class="lane-finish-line"><i class="fas fa-flag-checkered"></i></div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderMiniRoomSnapshot() {
  if (!els.miniRoomEvents) return;

  const sorted = getSortedPlayers();
  const leader = sorted[0];
  const currentUid = auth.currentUser?.uid;
  const me = state.mpPlayersData?.[currentUid];
  const totalPlayers = Object.keys(state.mpPlayersData || {}).length;

  els.miniRoomEvents.innerHTML = `
    <div class="snapshot-item">
      <span>Status</span>
      <strong>${escapeHtml(state.roomStatus || "waiting")}</strong>
    </div>
    <div class="snapshot-item">
      <span>Room</span>
      <strong>${escapeHtml(state.mpRoomId || "-")}</strong>
    </div>
    <div class="snapshot-item">
      <span>Players</span>
      <strong>${totalPlayers}/${state.roomMaxPlayers}</strong>
    </div>
    <div class="snapshot-item">
      <span>Leader</span>
      <strong>${leader ? `${escapeHtml(leader.name)} · ${leader.wpm || 0} WPM` : "-"}</strong>
    </div>
    <div class="snapshot-item">
      <span>Your progress</span>
      <strong>${me ? `${me.progress || 0}%` : "-"}</strong>
    </div>
    <div class="snapshot-item">
      <span>Text length</span>
      <strong>${(state.currentRoomText || "").length} chars</strong>
    </div>
  `;
}

function toggleReady() {
  if (!state.mpRoomId || !state.mpPlayerId) return;
  if (state.roomStatus !== "waiting") return;

  state.isUserReady = !state.isUserReady;

  update(ref(rtdb, `rooms/${state.mpRoomId}/players/${state.mpPlayerId}`), {
    isReady: state.isUserReady,
  });

  updateReadyButtonUI();
}

function updateReadyButtonUI() {
  const btn = document.getElementById("btnReady");
  const t = translations[state.lang] || translations.en;

  if (!btn) return;

  btn.innerText = state.isUserReady
    ? t.btnNotReady || "Not Ready"
    : t.btnReady || "Ready";
  btn.classList.toggle("is-ready", state.isUserReady);
  btn.disabled = state.roomStatus !== "waiting";
}

async function startMultiplayerGame() {
  const currentUid = auth.currentUser?.uid;
  const t = translations[state.lang] || translations.en;

  if (!state.mpRoomId || !currentUid || state.hostId !== currentUid) {
    alert(t.msgOnlyHostCanStart || "Only the host can start the match!");
    return;
  }

  const players = Object.values(state.mpPlayersData || {});

  if (players.length < 2) {
    alert(
      t.msgNeedMorePlayers ||
        "At least 2 players are required to start the match.",
    );
    return;
  }

  const allReady = players.every((player) => player.isReady);
  if (!allReady) {
    alert(t.msgNotAllReady || "All players must be Ready!");
    return;
  }

  const countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  const newText = getRandomText("timetest", null, state.lang);
  const updates = {
    [`rooms/${state.mpRoomId}/status`]: "countdown",
    [`rooms/${state.mpRoomId}/text`]: newText,
    [`rooms/${state.mpRoomId}/duration`]: state.matchDuration,
    [`rooms/${state.mpRoomId}/countdownEndsAt`]: countdownEndsAt,
    [`rooms/${state.mpRoomId}/finishedAt`]: null,
  };

  await update(ref(rtdb), updates);
}

function prepareGameUI(text, duration) {
  state.text = text || "";
  state.currentRoomText = text || "";
  state.charIndex = 0;
  state.mistakes = 0;
  state.isTyping = false;
  state.isGameActive = false; // Not active until playing starts
  state.isPlayerFinished = false;
  state.resultsShown = false;
  state.scoreSaved = false;
  state.maxTime = parseInt(duration || DEFAULT_DURATION, 10);
  state.timeLeft = state.maxTime;
  state.heatmap = {};
  state.mpChartData = {};
  state.latestStats = { wpm: 0, accuracy: 100, progress: 0 };

  clearInterval(state.timer);
  clearTimeout(state.roomFinishTimeout);

  if (els.lobby.style.display !== "none") {
    els.lobby.classList.add("section-fade-out");
    setTimeout(() => {
      els.lobby.style.display = "none";
      els.game.style.display = "block";
      els.game.classList.add("section-fade-in");
      els.resultOverlay.classList.remove("active");

      setTimeout(() => {
        els.lobby.classList.remove("section-fade-out");
        els.game.classList.remove("section-fade-in");
      }, 400);
    }, 200);
  }

  if (els.time) els.time.innerText = formatTime(state.timeLeft);
  if (els.wpm) els.wpm.innerText = "0";
  if (els.acc) els.acc.innerText = "100%";
  if (els.gameStatusBadge) els.gameStatusBadge.innerText = "Starting...";

  renderText(state.text);
  initKeyboard();
  updateKeyboardHints(state.text[0]);
  renderRaceTrack(state.mpPlayersData);
  renderMiniRoomSnapshot();
  updateMatchMeta();

  if (els.input) {
    els.input.value = "";
    els.input.disabled = true; // Wait for GO!
  }
  if (els.overlay) els.overlay.classList.add("hidden");

  syncLocalPlayerState({
    progress: 0,
    wpm: 0,
    accuracy: 100,
    isFinished: false,
    finishedAt: null,
  });
}

function startRoomCountdown(room) {
  const target = room.countdownEndsAt || Date.now() + COUNTDOWN_SECONDS * 1000;
  if (state.roomCountdownTarget === target) return;

  clearInterval(state.countdownTimer);
  clearTimeout(state.countdownTransitionTimeout);

  state.roomCountdownTarget = target;

  // Prepare UI before countdown finishes so users see the game board
  prepareGameUI(room.text, room.duration);

  if (els.countdownOverlay) els.countdownOverlay.classList.add("active");

  const tick = () => {
    const remaining = Math.max(0, target - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    if (els.countdownNumber) {
      // show GO when <= 1s left to give clients time to render
      els.countdownNumber.innerText =
        remaining <= 1000 ? "GO!" : String(seconds);
    }
  };

  tick();

  state.countdownTimer = setInterval(() => {
    tick();
    if (Date.now() >= target) {
      clearInterval(state.countdownTimer);
      if (els.countdownNumber) els.countdownNumber.innerText = "GO!";
    }
  }, 120);

  if (auth.currentUser?.uid === state.hostId) {
    state.countdownTransitionTimeout = setTimeout(
      () => {
        update(ref(rtdb, `rooms/${state.mpRoomId}`), {
          status: "playing",
          startedAt: Date.now(),
        });
      },
      Math.max(0, target - Date.now()) + 150,
    );
  }
}

function hideCountdown() {
  clearInterval(state.countdownTimer);
  clearTimeout(state.countdownTransitionTimeout);
  state.countdownTransitionTimeout = null;
  state.roomCountdownTarget = null;

  if (els.countdownOverlay) {
    els.countdownOverlay.classList.remove("active");
  }
}

function startGame(text, duration = DEFAULT_DURATION) {
  // Fallback in case prepareGameUI wasn't called (e.g. joined mid-game)
  if (els.lobby.style.display !== "none") {
    prepareGameUI(text, duration);
  }

  state.isGameActive = true;
  state.charIndex = 0;
  state.mistakes = 0;
  state.isPlayerFinished = false;
  state.latestStats = { wpm: 0, accuracy: 100, progress: 0 };

  syncLocalPlayerState(
    {
      progress: 0,
      wpm: 0,
      accuracy: 100,
      isFinished: false,
      finishedAt: null,
    },
    true,
  );

  if (els.gameStatusBadge) els.gameStatusBadge.innerText = "Racing";

  if (els.input) {
    els.input.disabled = false;
    els.input.focus();
  }

  if (els.overlay) els.overlay.classList.add("hidden");

  clearInterval(state.timer);
  const matchDuration = duration || state.matchDuration || DEFAULT_DURATION;
  state.maxTime = matchDuration;
  state.timeLeft = matchDuration;
  const startedAt = Date.now();

  state.timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    state.timeLeft = Math.max(0, matchDuration - elapsed);

    if (els.time) els.time.innerText = formatTime(state.timeLeft);
    updateStats();
    updateWPMChart();
    renderMiniRoomSnapshot();

    if (state.timeLeft <= 0) {
      clearInterval(state.timer);
      finishPlayerRun("time");
    }
  }, 250);
  // If the current user is the host, schedule server-side room finish
  if (auth.currentUser?.uid === state.hostId) {
    clearTimeout(state.roomFinishTimeout);
    state.roomFinishTimeout = setTimeout(
      () => {
        update(ref(rtdb, `rooms/${state.mpRoomId}`), {
          status: "finished",
          finishedAt: Date.now(),
        });
      },
      state.maxTime * 1000 + 1200,
    );
  }
}

function renderText(text) {
  els.display.innerHTML = "";
  state.charSpans = [];

  text.split("").forEach((char) => {
    const span = document.createElement("span");
    span.innerText = char;
    els.display.appendChild(span);
    state.charSpans.push(span);
  });

  if (state.charSpans.length > 0) {
    state.charSpans[0].classList.add("active");
    if (state.smoothCaret) updateSmoothCaret();
  }
}

function handleTyping() {
  if (!state.isGameActive || state.isPlayerFinished) return;

  if (!state.isTyping) {
    state.isTyping = true;
    if (els.overlay) els.overlay.classList.add("hidden");
  }

  const inputChars = els.input.value.split("");
  const typedChar = inputChars[state.charIndex];
  const currSpan = state.charSpans[state.charIndex];

  if (!currSpan) return;

  if (state.soundEnabled) playMechanicalClick();

  if (typedChar == null) {
    if (state.charIndex > 0) {
      state.charIndex--;
      const prevSpan = state.charSpans[state.charIndex];

      if (prevSpan.classList.contains("incorrect")) {
        state.mistakes = Math.max(0, state.mistakes - 1);
      }

      prevSpan.classList.remove("correct", "incorrect", "active");
      prevSpan.classList.add("active");
      updateKeyboardHints(prevSpan.innerText);
      if (state.smoothCaret) updateSmoothCaret();
    }
  } else {
    if (currSpan.innerText === typedChar) {
      currSpan.classList.add("correct");
    } else {
      state.mistakes++;
      currSpan.classList.add("incorrect");
      const expectedChar = currSpan.innerText.toLowerCase();
      state.heatmap[expectedChar] = (state.heatmap[expectedChar] || 0) + 1;
    }

    currSpan.classList.remove("active");
    state.charIndex++;

    if (state.charIndex < state.charSpans.length) {
      const nextSpan = state.charSpans[state.charIndex];
      nextSpan.classList.add("active");

      if (
        nextSpan.offsetTop >
        els.display.clientHeight + els.display.scrollTop - 50
      ) {
        els.display.scrollTop = nextSpan.offsetTop - 50;
      }

      updateKeyboardHints(nextSpan.innerText);
      if (state.smoothCaret) updateSmoothCaret();
    } else {
      finishPlayerRun("completed");
    }
  }

  updateStats();
  if (state.heatmapEnabled) updateKeyboardHeatmap();

  syncLocalPlayerState({
    progress: state.latestStats.progress,
    wpm: state.latestStats.wpm,
    accuracy: state.latestStats.accuracy,
  });
}

function updateStats() {
  const elapsedSeconds = state.maxTime - state.timeLeft;
  const elapsedMinutes = Math.max(elapsedSeconds / 60, 1 / 600);
  const netChars = Math.max(0, state.charIndex - state.mistakes);
  const wpm = Math.max(0, Math.round(netChars / 5 / elapsedMinutes));
  const accuracy =
    state.charIndex > 0
      ? Math.max(
          0,
          Math.round(
            ((state.charIndex - state.mistakes) / state.charIndex) * 100,
          ),
        )
      : 100;
  const progress = state.charSpans.length
    ? Math.min(
        100,
        Math.round((state.charIndex / state.charSpans.length) * 100),
      )
    : 0;

  state.latestStats = {
    wpm,
    accuracy,
    progress,
  };

  if (els.wpm) els.wpm.innerText = String(wpm);
  if (els.acc) els.acc.innerText = `${accuracy}%`;
}

let syncThrottleTimer = null;
let pendingSyncPayload = null;

function syncLocalPlayerState(partial, immediate = false) {
  if (!state.mpRoomId || !state.mpPlayerId) return;

  pendingSyncPayload = { ...(pendingSyncPayload || {}), ...partial };

  const flush = () => {
    if (syncThrottleTimer) {
      clearTimeout(syncThrottleTimer);
      syncThrottleTimer = null;
    }
    if (pendingSyncPayload && state.mpRoomId && state.mpPlayerId) {
      const payload = { ...pendingSyncPayload };
      pendingSyncPayload = null;
      update(
        ref(rtdb, `rooms/${state.mpRoomId}/players/${state.mpPlayerId}`),
        payload,
      ).catch((err) => console.warn("Failed to sync player state:", err));
    }
  };

  if (immediate || partial.isFinished) {
    flush();
    return;
  }

  if (!syncThrottleTimer) {
    syncThrottleTimer = setTimeout(() => {
      flush();
    }, 200);
  }
}

function finishPlayerRun(reason = "completed") {
  if (state.isPlayerFinished) return;

  clearInterval(state.timer);
  state.isPlayerFinished = true;
  state.isGameActive = false;

  if (els.input) {
    els.input.value = "";
    els.input.disabled = true;
  }

  if (els.overlay) els.overlay.classList.remove("hidden");
  if (els.gameStatusBadge) {
    els.gameStatusBadge.innerText =
      reason === "completed" ? "Finished" : "Time Up";
  }

  syncLocalPlayerState(
    {
      progress: reason === "completed" ? 100 : state.latestStats.progress,
      wpm: state.latestStats.wpm,
      accuracy: state.latestStats.accuracy,
      isFinished: true,
      finishedAt: Date.now(),
    },
    true,
  );

  showToast(
    reason === "completed"
      ? "Run finished. Waiting for room results..."
      : "Time up. Waiting for room results...",
    "success",
  );
}

function maybeFinishRoom(players) {
  if (!state.mpRoomId || auth.currentUser?.uid !== state.hostId) return;
  if (state.roomStatus !== "playing") return;

  const entries = Object.values(players || {});
  if (!entries.length) return;

  const everyoneFinished = entries.every((player) => player.isFinished);
  if (everyoneFinished) {
    update(ref(rtdb, `rooms/${state.mpRoomId}`), {
      status: "finished",
      finishedAt: Date.now(),
    });
  }
}

function finalizeRoomResults() {
  if (state.resultsShown) return;

  clearInterval(state.timer);
  state.resultsShown = true;
  state.isGameActive = false;

  if (!state.isPlayerFinished) {
    finishPlayerRun("time");
  }

  if (els.finalWpm) els.finalWpm.innerText = String(state.latestStats.wpm || 0);
  if (els.finalAcc)
    els.finalAcc.innerText = `${state.latestStats.accuracy || 100}%`;
  if (els.finalTime)
    els.finalTime.innerText = formatTime(state.maxTime - state.timeLeft);

  const sorted = getSortedPlayers();
  renderFinalLeaderboard(sorted);

  if (!state.scoreSaved) {
    const user = auth.currentUser;
    saveGameScore(
      "multiplayer",
      state.latestStats.wpm || 0,
      state.latestStats.accuracy || 100,
    );

    if (user && state.roomMode === "ranked") {
      applyRankedMatchResults(user, sorted);
    }

    state.scoreSaved = true;
  }

  if (els.resultOverlay) els.resultOverlay.classList.add("active");
}

function calculateEloChanges(
  sortedPlayers,
  currentUid,
  myVerifiedElo,
  opponentEloMap = {},
) {
  const N = sortedPlayers.length;
  if (N < 2) return 0;

  const myIndex = sortedPlayers.findIndex((p) => p.uid === currentUid);
  if (myIndex === -1) return 0;

  const Ra =
    myVerifiedElo != null
      ? myVerifiedElo
      : sortedPlayers[myIndex].elo || 1000;
  const K = 32;

  let totalScoreDiff = 0;

  sortedPlayers.forEach((opp, oppIndex) => {
    if (opp.uid === currentUid) return;
    const Rb =
      opponentEloMap[opp.uid] != null
        ? opponentEloMap[opp.uid]
        : opp.elo || 1000;
    const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
    let Sa = 0.5;
    if (myIndex < oppIndex) Sa = 1;
    else if (myIndex > oppIndex) Sa = 0;

    totalScoreDiff += Sa - Ea;
  });

  return Math.round((K / (N - 1)) * totalScoreDiff);
}

function renderEloResultBadge(deltaElo, newElo, myRank) {
  const header = document.querySelector(".result-card h2");
  if (!header) return;

  const existing = document.getElementById("rankedResultBadge");
  if (existing) existing.remove();

  const badge = document.createElement("div");
  badge.id = "rankedResultBadge";
  badge.className = "ranked-result-badge";
  const sign = deltaElo >= 0 ? `+${deltaElo}` : `${deltaElo}`;
  const color = deltaElo >= 0 ? "#4ade80" : "#f87171";

  badge.innerHTML = `
    <div style="font-size: 0.9rem; color: #94a3b8;">Ranked Placement: <strong style="color: #f8fafc;">#${myRank}</strong></div>
    <div style="font-size: 1.25rem; font-weight: 700; color: ${color}; margin-top: 4px;">
      ${sign} ELO <span style="color: #cbd5e1; font-weight: normal; font-size: 0.95rem;">(${newElo} ELO)</span>
    </div>
  `;
  header.after(badge);
}

function updateRankUI() {
  const eloVal = document.getElementById("myEloValue");
  const rankBadge = document.getElementById("myRankBadge");
  if (eloVal) eloVal.innerText = `${state.myElo || 1000} ELO`;
  if (rankBadge) rankBadge.innerHTML = getRankBadgeHTML(state.myElo || 1000);
}

async function applyRankedMatchResults(user, sorted) {
  const myIndex = sorted.findIndex((p) => p.uid === user.uid);
  const myRank = myIndex !== -1 ? myIndex + 1 : sorted.length;

  try {
    const userRef = doc(db, "users", user.uid);

    // Fetch verified opponent ELOs from Firestore to prevent RTDB spoofing
    const opponentUids = sorted
      .filter((p) => p.uid !== user.uid)
      .map((p) => p.uid);
    const opponentEloMap = {};

    await Promise.all(
      opponentUids.map(async (uid) => {
        try {
          const oppSnap = await getDoc(doc(db, "users", uid));
          if (oppSnap.exists() && oppSnap.data().elo != null) {
            opponentEloMap[uid] = oppSnap.data().elo;
          }
        } catch (_) {}
      }),
    );

    let calculatedDelta = 0;
    let finalNewElo = 1000;
    let oldElo = 1000;

    // Atomic Firestore transaction to prevent race conditions across tabs/devices
    await runFirestoreTransaction(db, async (transaction) => {
      const userSnap = await transaction.get(userRef);
      oldElo =
        userSnap.exists() && userSnap.data().elo != null
          ? userSnap.data().elo
          : 1000;

      calculatedDelta = calculateEloChanges(
        sorted,
        user.uid,
        oldElo,
        opponentEloMap,
      );
      finalNewElo = Math.max(100, oldElo + calculatedDelta);

      const existingHistory =
        userSnap.exists() && Array.isArray(userSnap.data().eloHistory)
          ? [...userSnap.data().eloHistory]
          : [oldElo];

      // Direct push preserves duplicate values without arrayUnion deduplication bug
      existingHistory.push(finalNewElo);
      const trimmedHistory = existingHistory.slice(-50);

      const currentMatches =
        userSnap.exists() && typeof userSnap.data().matches_played === "number"
          ? userSnap.data().matches_played
          : 0;

      transaction.update(userRef, {
        elo: finalNewElo,
        eloHistory: trimmedHistory,
        matches_played: currentMatches + 1,
      });
    });

    state.myElo = finalNewElo;
    if (!state.myEloHistory) state.myEloHistory = [oldElo];
    state.myEloHistory.push(finalNewElo);

    renderEloResultBadge(calculatedDelta, finalNewElo, myRank);
    updateRankUI();
    renderMobaRankChart(state.myEloHistory);

    // Persist complete match history record
    await addDoc(collection(db, "matches_history"), {
      uid: user.uid,
      roomId: state.mpRoomId,
      mode: state.roomMode,
      duration: state.matchDuration,
      placement: myRank,
      totalPlayers: sorted.length,
      wpm: state.latestStats.wpm || 0,
      accuracy: state.latestStats.accuracy || 100,
      eloBefore: oldElo,
      eloAfter: finalNewElo,
      eloDelta: calculatedDelta,
      opponents: sorted
        .filter((p) => p.uid !== user.uid)
        .map((p) => ({
          uid: p.uid,
          name: p.name || "Guest",
          wpm: p.wpm || 0,
          elo: opponentEloMap[p.uid] || p.elo || 1000,
        })),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to persist ranked match result:", err);
  }
}

function renderFinalLeaderboard(sorted = getSortedPlayers()) {
  if (!els.finalLeaderboard) return;

  if (!sorted.length) {
    els.finalLeaderboard.innerHTML = `<div class="empty-race-state">No result data.</div>`;
    return;
  }

  const currentUid = auth.currentUser?.uid;

  els.finalLeaderboard.innerHTML = sorted
    .map((player, index) => {
      const isMe = player.uid === currentUid;
      return `
        <div class="final-leaderboard-item ${isMe ? "me" : ""}">
          <div class="final-leaderboard-rank">#${index + 1}</div>
          <div class="final-leaderboard-player">
            <div class="final-leaderboard-name">${escapeHtml(player.name || "Guest")}${isMe ? " <span>(You)</span>" : ""}</div>
            <div class="final-leaderboard-meta">${player.progress || 0}% progress · ${player.accuracy || 100}% accuracy</div>
          </div>
          <div class="final-leaderboard-score">${player.wpm || 0} WPM</div>
        </div>
      `;
    })
    .join("");
}

let chartUpdateTimeout = null;

function updateWPMChart() {
  if (chartUpdateTimeout) return;
  chartUpdateTimeout = setTimeout(() => {
    chartUpdateTimeout = null;
    const canvas = document.getElementById("mpChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const currentSecond = Math.max(0, state.maxTime - state.timeLeft);

    Object.keys(state.mpPlayersData || {}).forEach((uid) => {
      if (!state.mpChartData[uid]) state.mpChartData[uid] = [];
      const player = state.mpPlayersData[uid];
      state.mpChartData[uid].push({
        x: currentSecond,
        y: player.wpm || 0,
      });
    });

    const parent = canvas.parentNode;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = Math.max(220, rect.height - 48);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const padding = 24;
    const plotWidth = canvas.width - padding * 2;
    const plotHeight = canvas.height - padding * 2;
    const maxSeconds = Math.max(state.maxTime, 1);

    let maxWPM = 60;
    Object.values(state.mpChartData).forEach((arr) => {
      arr.forEach((point) => {
        if (point.y > maxWPM) maxWPM = point.y;
      });
    });
    maxWPM += 10;

    ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
      const y = padding + (plotHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(canvas.width - padding, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(56, 189, 248, 0.2)";
    ctx.beginPath();
    ctx.moveTo(padding, canvas.height - padding);
    ctx.lineTo(canvas.width - padding, canvas.height - padding);
    ctx.stroke();

    Object.keys(state.mpChartData).forEach((uid) => {
      const points = state.mpChartData[uid];
      if (!points || points.length < 2) return;

      const color = getChartColor(uid);

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;

      points.forEach((point, index) => {
        const x =
          padding + (Math.min(point.x, maxSeconds) / maxSeconds) * plotWidth;
        const y = canvas.height - padding - (point.y / maxWPM) * plotHeight;

        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });

      ctx.stroke();
    });
  }, 50);
}

function getChartColor(uid) {
  if (state.chartColorMap[uid]) return state.chartColorMap[uid];

  const colors = ["#38bdf8", "#facc15", "#4ade80", "#f87171", "#c084fc"];
  const color = colors[state.chartColorCursor % colors.length];
  state.chartColorMap[uid] = color;
  state.chartColorCursor += 1;
  return color;
}

const keyboardLayout = [
  [
    "`",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "0",
    "-",
    "=",
    "Backspace",
  ],
  ["Tab", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"],
  ["Caps", "a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", "Enter"],
  ["Shift", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/", "Shift"],
  ["Space"],
];

const fingerMap = {
  1: 1,
  q: 1,
  a: 1,
  z: 1,
  "`": 1,
  Tab: 1,
  Caps: 1,
  Shift: 1,
  2: 2,
  w: 2,
  s: 2,
  x: 2,
  3: 3,
  e: 3,
  d: 3,
  c: 3,
  4: 4,
  r: 4,
  f: 4,
  v: 4,
  5: 4,
  t: 4,
  g: 4,
  b: 4,
  " ": 5,
  6: 6,
  y: 6,
  h: 6,
  n: 6,
  7: 6,
  u: 6,
  j: 6,
  m: 6,
  8: 7,
  i: 7,
  k: 7,
  ",": 7,
  9: 8,
  o: 8,
  l: 8,
  ".": 8,
  0: 9,
  p: 9,
  ";": 9,
  "/": 9,
  "-": 9,
  "=": 9,
  "[": 9,
  "]": 9,
  "'": 9,
  "\\": 9,
  Enter: 9,
  Backspace: 9,
};

function initKeyboard() {
  const kbContainer = document.querySelector(".keyboard-container");
  if (!kbContainer) return;

  kbContainer.innerHTML = "";

  keyboardLayout.forEach((row) => {
    const rowDiv = document.createElement("div");
    rowDiv.className = "keyboard-row";

    row.forEach((key) => {
      const keyDiv = document.createElement("div");
      keyDiv.className = `key ${key.toLowerCase()}`;
      keyDiv.innerText = key === "Space" ? "" : key;
      keyDiv.dataset.key = key.toLowerCase();
      const finger = fingerMap[key.toLowerCase()] || fingerMap[key] || 9;
      keyDiv.dataset.finger = finger;
      rowDiv.appendChild(keyDiv);
    });

    kbContainer.appendChild(rowDiv);
  });

  const handsDiv = document.createElement("div");
  handsDiv.className = "hands-wrapper";

  const leftHand = document.createElement("div");
  leftHand.className = "hand left";
  [1, 2, 3, 4, 5].forEach((fingerId) => {
    const finger = document.createElement("div");
    finger.className = `finger ${getFingerName(fingerId)}`;
    finger.dataset.fingerId = fingerId;
    leftHand.appendChild(finger);
  });

  const rightHand = document.createElement("div");
  rightHand.className = "hand right";
  [5, 6, 7, 8, 9].forEach((fingerId) => {
    const finger = document.createElement("div");
    finger.className = `finger ${getFingerName(fingerId)}`;
    finger.dataset.fingerId = fingerId;
    rightHand.appendChild(finger);
  });

  handsDiv.appendChild(leftHand);
  handsDiv.appendChild(rightHand);
  kbContainer.appendChild(handsDiv);
}

function getFingerName(id) {
  if (id === 1 || id === 9) return "pinky";
  if (id === 2 || id === 8) return "ring";
  if (id === 3 || id === 7) return "middle";
  if (id === 4 || id === 6) return "index";
  return "thumb";
}

const specialKeyMap = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

function updateKeyboardHints(char) {
  if (!char) return;

  const lowerChar = char.toLowerCase();
  document
    .querySelectorAll(".key.active, .finger.active")
    .forEach((element) => element.classList.remove("active"));

  let targetKey = lowerChar;
  if (specialKeyMap[char]) targetKey = specialKeyMap[char];

  let keyEl = null;
  try {
    keyEl = document.querySelector(`.key[data-key="${CSS.escape(targetKey)}"]`);
  } catch (error) {
    keyEl = null;
  }

  if (keyEl) {
    keyEl.classList.add("active");
    const fingerId = keyEl.dataset.finger;
    if (fingerId) {
      document
        .querySelectorAll(`.finger[data-finger-id="${fingerId}"]`)
        .forEach((finger) => finger.classList.add("active"));
    }

    if (char !== lowerChar || '!@#$%^&*()_+{}|:"<>?~'.includes(char)) {
      const shiftKey = document.querySelector(".key.shift");
      if (shiftKey) shiftKey.classList.add("active");
    }
  } else if (char === " ") {
    const spaceKey = document.querySelector(".key.space");
    if (spaceKey) spaceKey.classList.add("active");
    document
      .querySelectorAll(".finger.thumb")
      .forEach((finger) => finger.classList.add("active"));
  }
}

function updateKeyboardHeatmap() {
  document.querySelectorAll(".key").forEach((key) => {
    key.classList.remove("heat-1", "heat-2", "heat-3", "heat-4", "heat-5");
  });

  if (!state.heatmapEnabled) return;

  Object.keys(state.heatmap).forEach((char) => {
    const count = state.heatmap[char];
    let heatClass = "";

    if (count >= 10) heatClass = "heat-5";
    else if (count >= 7) heatClass = "heat-4";
    else if (count >= 5) heatClass = "heat-3";
    else if (count >= 3) heatClass = "heat-2";
    else if (count >= 1) heatClass = "heat-1";

    if (!heatClass) return;

    try {
      const keyEl = document.querySelector(
        `.key[data-key="${CSS.escape(char)}"]`,
      );
      if (keyEl) keyEl.classList.add(heatClass);
    } catch (error) {
      console.warn("Heatmap key error", error);
    }
  });
}

function updateSmoothCaret() {
  let caret = document.getElementById("smoothCaret");

  if (!caret) {
    caret = document.createElement("div");
    caret.id = "smoothCaret";
    const style = localStorage.getItem("cursorStyle") || "underscore";
    caret.className = `cursor-${style}`;
    els.display.appendChild(caret);
  }

  const activeSpan = state.charSpans[state.charIndex];
  if (!activeSpan) return;

  const left = activeSpan.offsetLeft;
  const top = activeSpan.offsetTop;
  const width = activeSpan.offsetWidth;
  const height = activeSpan.offsetHeight;

  caret.style.left = `${left}px`;
  caret.style.top = `${top}px`;

  if (
    caret.classList.contains("cursor-block") ||
    caret.classList.contains("cursor-underscore")
  ) {
    caret.style.width = `${width}px`;
  }

  caret.style.height = `${height}px`;
}

let audioCtx = null;

function playMechanicalClick() {
  try {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioCtx = new AudioContext();
    }

    if (audioCtx.state === "suspended") audioCtx.resume();

    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(150, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      40,
      audioCtx.currentTime + 0.1,
    );

    const volume =
      (parseInt(localStorage.getItem("gameVolume") || 80, 10) / 100) * 0.5;
    gainNode.gain.setValueAtTime(volume, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.01,
      audioCtx.currentTime + 0.1,
    );

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.1);
  } catch (error) {
    console.warn("Sound playback failed", error);
  }
}

function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem("typingSound", state.soundEnabled);
  updateControlButtons();
  if (state.soundEnabled) playMechanicalClick();
}

function toggleZenMode() {
  state.zenMode = !state.zenMode;
  document.body.classList.toggle("zen-mode", state.zenMode);
  updateControlButtons();
}

function toggleHeatmap() {
  state.heatmapEnabled = !state.heatmapEnabled;
  updateControlButtons();
  updateKeyboardHeatmap();
}

function updateControlButtons() {
  const soundBtn = document.getElementById("btnSound");
  const zenBtn = document.getElementById("btnZen");
  const heatBtn = document.getElementById("btnHeatmap");

  if (soundBtn) {
    soundBtn.classList.toggle("active", state.soundEnabled);
    soundBtn.innerHTML = state.soundEnabled
      ? '<i class="fas fa-volume-up"></i> Sound On'
      : '<i class="fas fa-volume-mute"></i> Sound Off';
  }

  if (zenBtn) zenBtn.classList.toggle("active", state.zenMode);

  if (heatBtn) {
    heatBtn.classList.toggle("active", state.heatmapEnabled);
    heatBtn.innerHTML = state.heatmapEnabled
      ? '<i class="fas fa-fire"></i> Heatmap On'
      : '<i class="fas fa-fire-alt"></i> Heatmap Off';
  }
}

function initStars() {
  const isEffectsOn = localStorage.getItem("bgEffects") !== "off";
  if (!isEffectsOn) return;

  let container = document.getElementById("starsContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "starsContainer";
    container.className = "stars";
    document.body.prepend(container);
  }

  container.innerHTML = "";

  for (let i = 0; i < 200; i++) {
    const star = document.createElement("div");
    star.className = "star";
    const size = Math.random() * 2 + 1;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.animationDelay = `${Math.random() * 5}s`;
    star.style.opacity = Math.random() * 0.7 + 0.3;
    container.appendChild(star);
  }
}

function applyGlobalLanguage(lang) {
  const t = translations[lang];
  if (!t) return;

  document.querySelectorAll("[data-translate]").forEach((el) => {
    const key = el.getAttribute("data-translate");
    if (t[key]) el.innerHTML = t[key];
  });

  const navLinks = document.querySelectorAll(".nav-links > a");
  navLinks.forEach((link) => {
    if (link.href.includes("index.html")) link.innerText = t.navHome;
    if (link.href.includes("about.html")) link.innerText = t.navAbout;
    if (link.href.includes("tips.html")) link.innerText = t.navTips;
    if (link.href.includes("FAQ.html")) link.innerText = t.navFAQ;
    if (link.href.includes("typing.html")) link.innerText = t.navTyping;
    if (link.href.includes("contact.html")) link.innerText = t.navContact;
    if (link.href.includes("multiplayer.html"))
      link.innerText = t.tabMultiplayer;
  });
}

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const icon = type === "success" ? "fa-check-circle" : "fa-exclamation-circle";

  toast.innerHTML = `
    <i class="fas ${icon}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => toast.remove(), {
      once: true,
    });
  }, 3000);
}

window.mentionUser = function mentionUser(name) {
  const input = document.getElementById("chatInput");
  if (!input) return;

  input.value = `@${name} `;
  input.focus();
};

window.kickPlayer = function kickPlayer(uid) {
  const t = translations[state.lang] || translations.en;
  if (!state.mpRoomId || state.hostId !== auth.currentUser?.uid) return;

  if (confirm(t.confirmKick || "Kick this player?")) {
    remove(ref(rtdb, `rooms/${state.mpRoomId}/players/${uid}`));
  }
};

function handleChatTyping() {
  if (!state.mpRoomId || !auth.currentUser) return;

  const typingRef = ref(
    rtdb,
    `rooms/${state.mpRoomId}/typing/${auth.currentUser.uid}`,
  );

  set(typingRef, auth.currentUser.displayName || "Guest");
  onDisconnect(typingRef).remove();

  if (state.typingTimeout) clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    remove(typingRef);
  }, 2000);
}

function setupTypingListener(roomId) {
  const typingIndicator = document.getElementById("typingIndicator");
  if (!typingIndicator) return;

  const typingUnsub = onValue(
    ref(rtdb, `rooms/${roomId}/typing`),
    (snapshot) => {
      const data = snapshot.val() || {};
      const currentUid = auth.currentUser?.uid;

      const names = Object.keys(data)
        .filter((uid) => uid !== currentUid)
        .map((uid) => data[uid]);

      typingIndicator.innerText =
        names.length > 0
          ? `${names.join(", ")} ${(translations[state.lang] || translations.en).lblTyping || "is typing..."}`
          : "";
    },
  );

  state.roomUnsubscribers.push(typingUnsub);
}

function sendChat() {
  const input = document.getElementById("chatInput");
  if (!input) return;

  const text = input.value.trim();
  if (!text || !state.mpRoomId || !auth.currentUser) return;

  push(ref(rtdb, `rooms/${state.mpRoomId}/chat`), {
    user: auth.currentUser.displayName || "Guest",
    text,
    timestamp: Date.now(),
  }).catch((error) => console.error("Chat send error:", error));

  if (state.typingTimeout) clearTimeout(state.typingTimeout);
  remove(ref(rtdb, `rooms/${state.mpRoomId}/typing/${auth.currentUser.uid}`));

  input.value = "";
  input.focus();
}

function appendChatMessage(user, text, timestamp) {
  const container = document.getElementById("chatMessages");
  if (!container) return;

  const wrapper = document.createElement("div");
  wrapper.className = "chat-msg";

  const author = document.createElement("strong");
  author.textContent = `${user}:`;

  const message = document.createElement("span");
  message.textContent = ` ${text}`;
  wrapper.appendChild(author);
  wrapper.appendChild(message);

  if (timestamp) {
    const meta = document.createElement("small");
    meta.className = "chat-msg-time";
    meta.textContent = ` · ${new Date(timestamp).toLocaleTimeString()}`;
    wrapper.appendChild(meta);
  }

  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

async function loadUserProfile() {
  const user = auth.currentUser;
  if (!user) return;

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);

  let data;

  if (!userSnap.exists()) {
    const newShortId = Math.floor(
      10000000 + Math.random() * 90000000,
    ).toString();
    await setDoc(
      userRef,
      {
        uid: user.uid,
        name: user.displayName || "Guest",
        email: user.email || "",
        photoURL: user.photoURL || "",
        createdAt: new Date().toISOString(),
        shortId: newShortId,
        role: "member",
        wpm_best: 0,
        matches_played: 0,
        elo: 1000,
        eloHistory: [1000],
        friends: [],
      },
      { merge: true },
    );
    data = { shortId: newShortId, friends: [], elo: 1000, eloHistory: [1000] };
  } else {
    data = userSnap.data();
    if (data.elo === undefined) {
      data.elo = 1000;
      await updateDoc(userRef, { elo: 1000, eloHistory: [1000] });
    }
  }

  state.myElo = data.elo != null ? data.elo : 1000;
  state.myEloHistory =
    Array.isArray(data.eloHistory) && data.eloHistory.length > 0
      ? data.eloHistory
      : [state.myElo];

  updateRankUI();
  renderMobaRankChart(state.myEloHistory);

  const idDisplay = document.getElementById("myShortId");
  if (idDisplay) {
    if (!data.shortId) {
      const newShortId = Math.floor(
        10000000 + Math.random() * 90000000,
      ).toString();
      await updateDoc(userRef, { shortId: newShortId });
      idDisplay.innerText = `ID: ${newShortId}`;
    } else {
      idDisplay.innerText = `ID: ${data.shortId}`;
    }
  }

  renderFriendsList(data.friends || []);
}

async function addFriend() {
  const input = document.getElementById("friendIdInput");
  const btn = document.getElementById("btnAddFriend");
  const friendId = input.value.trim();
  const t = translations[state.lang] || translations.en;
  const user = auth.currentUser;

  if (!user) {
    showToast(t.msgLoginRequired || "You must be logged in to add friends.", "error");
    return;
  }

  if (!friendId) {
    showToast(t.msgInvalidFriendId || "Please enter a Friend ID.", "error");
    return;
  }

  // shortId is always 8 digits
  if (!/^\d{8}$/.test(friendId)) {
    showToast(t.msgInvalidFriendId || "Friend ID must be 8 digits.", "error");
    return;
  }

  // Loading state
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

  try {
    try {
      await user.getIdToken(true);
    } catch (error) {
      console.error("addFriend token refresh failed", error);
      showToast(t.msgAuthExpired || "Session expired. Please refresh and login again.", "error");
      return;
    }

    const usersRef = collection(db, "users");
    const q = query(usersRef, where("shortId", "==", friendId));

    let querySnapshot;
    try {
      querySnapshot = await getDocs(q);
    } catch (error) {
      console.error("addFriend query failed", error);
      showToast(t.msgFriendQueryError || "Unable to search users. Please try again.", "error");
      return;
    }

    if (querySnapshot.empty) {
      showToast(t.msgUserNotFound || "No user found with that ID.", "error");
      return;
    }

    const friendDoc = querySnapshot.docs[0];
    const friendData = friendDoc.data();

    if (!friendData.uid) {
      showToast(t.msgUserNotFound || "User not found!", "error");
      return;
    }

    if (friendData.uid === user.uid) {
      showToast(t.msgCannotAddYourself || "You cannot add yourself.", "error");
      return;
    }

    const currentUserRef = doc(db, "users", user.uid);
    let currentUserSnap = await getDoc(currentUserRef);

    if (!currentUserSnap.exists()) {
      await setDoc(
        currentUserRef,
        {
          uid: user.uid,
          name: user.displayName || "Guest",
          email: user.email || "",
          photoURL: user.photoURL || "",
          createdAt: new Date().toISOString(),
          shortId: "",
          role: "member",
          wpm_best: 0,
          matches_played: 0,
          friends: [],
        },
        { merge: true },
      );
      currentUserSnap = await getDoc(currentUserRef);
    }

    const currentFriends = currentUserSnap.exists()
      ? currentUserSnap.data().friends || []
      : [];

    if (currentFriends.some((friend) => friend.uid === friendData.uid)) {
      showToast(t.msgFriendAlreadyAdded || "Already in your friends list!", "error");
      return;
    }

    try {
      await updateDoc(currentUserRef, {
        friends: arrayUnion({
          uid: friendData.uid,
          name: friendData.name || friendData.email || "Friend",
          photoURL: friendData.photoURL || "",
          shortId: friendData.shortId || "",
        }),
      });
    } catch (error) {
      console.error("addFriend update failed", error);
      showToast(t.msgFriendSaveError || "Unable to save friend. Please try again.", "error");
      return;
    }

    showToast(`${t.msgFriendAdded || "Friend added!"} 🎉`, "success");
    input.value = "";
    loadUserProfile();
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus"></i>'; }
  }
}

function inviteFriendToRoom(friend) {
  const t = translations[state.lang] || translations.en;
  if (!state.mpRoomId) {
    alert(t.msgInviteRequireRoom || "Join or create a room to invite friends.");
    return;
  }

  copyInviteLink();
  showToast(
    `${friend.name} · ${t.msgLinkCopied || "Link copied to clipboard!"}`,
  );
}

function renderFriendsList(friends) {
  const list = document.getElementById("friendsList");
  const t = translations[state.lang] || translations.en;
  if (!list) return;
  // keep a reference for event handlers
  state.friendsList = Array.isArray(friends) ? friends : [];

  if (!state.friendsList.length) {
    list.innerHTML = `<div class="no-friends">${t.msgNoFriends || "No friends yet. Add someone by ID above."}</div>`;
    return;
  }

  list.innerHTML = state.friendsList
    .map(
      (friend) => `
        <div class="friend-item" data-uid="${escapeHtml(friend.uid)}">
          <img src="${escapeHtml(friend.photoURL || "https://ui-avatars.com/api/?background=random")}" class="player-avatar" alt="${escapeHtml(friend.name || "Friend")}">
          <div class="friend-copy">
            <span>${escapeHtml(friend.name || "Friend")}</span>
            <small>ID: ${escapeHtml(friend.shortId || "-")}</small>
          </div>
          <button type="button" class="btn-icon small friend-invite-btn" data-uid="${escapeHtml(friend.uid)}" title="${t.btnInvite || "Invite"}">
            <i class="fas fa-link"></i>
          </button>
          <div class="friend-status"></div>
        </div>
      `,
    )
    .join("");

  // open chat when clicking the item
  list.querySelectorAll(".friend-item").forEach((item) => {
    item.addEventListener("click", () => {
      const uid = item.dataset.uid;
      const friendObj = state.friendsList.find((f) => f.uid === uid);
      if (!friendObj) return;
      openFriendChat(friendObj);
    });
  });

  // invite button
  list.querySelectorAll(".friend-invite-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const uid = btn.dataset.uid;
      const friendObj = state.friendsList.find((f) => f.uid === uid);
      if (!friendObj) return;
      inviteFriendToRoom(friendObj);
    });
  });
}

let friendChatUnsubscribe = null;
let currentFriendChat = null;

function getFriendChatId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

function closeFriendChat() {
  const panel = document.getElementById("friendChatPanel");
  if (panel) panel.style.display = "none";

  currentFriendChat = null;

  if (friendChatUnsubscribe) {
    friendChatUnsubscribe();
    friendChatUnsubscribe = null;
  }
}

async function openFriendChat(friend) {
  if (!friend || !friend.uid || !auth.currentUser) return;

  const t = translations[state.lang] || translations.en;
  const title = document.getElementById("friendChatTitle");
  const subtitle = document.getElementById("friendChatSubtitle");
  const panel = document.getElementById("friendChatPanel");
  const chatMessages = document.getElementById("friendChatMessages");

  if (!panel || !chatMessages || !title || !subtitle) return;

  panel.style.display = "flex";
  title.innerText = `${friend.name || t.lblFriends} ${t.lblChat}`;
  subtitle.innerText = t.msgFriendChatActive || "Chat with your friend.";
  chatMessages.innerHTML = `<div class="loading">${t.lblLoading || "Loading..."}</div>`;

  currentFriendChat = friend;

  if (friendChatUnsubscribe) friendChatUnsubscribe();

  const chatId = getFriendChatId(auth.currentUser.uid, friend.uid);
  const messagesRef = collection(db, "friend_chats", chatId, "messages");
  const q = query(messagesRef, orderBy("timestamp", "asc"));

  friendChatUnsubscribe = onSnapshot(q, (snapshot) => {
    const messages = [];
    snapshot.forEach((messageDoc) => messages.push(messageDoc.data()));
    renderFriendChatMessages(messages, friend);
  });
}

function renderFriendChatMessages(messages, friend) {
  const chatMessages = document.getElementById("friendChatMessages");
  const t = translations[state.lang] || translations.en;
  if (!chatMessages) return;

  if (!messages || messages.length === 0) {
    chatMessages.innerHTML = `<div class="no-friends">${t.msgNoChatHistory || "No messages yet. Say hello!"}</div>`;
    return;
  }

  chatMessages.innerHTML = messages
    .map((message) => {
      const isMine = message.senderUid === auth.currentUser.uid;
      const rawTime = message.timestamp?.toDate
        ? message.timestamp.toDate()
        : new Date(message.timestamp || Date.now());

      return `
        <div class="friend-chat-bubble ${isMine ? "mine" : "friend"}">
          <div class="friend-chat-text">${escapeHtml(message.text || "")}</div>
          <div class="friend-chat-meta">${isMine ? t.lblYou || "You" : escapeHtml(friend.name || "Friend")} · ${rawTime.toLocaleTimeString()}</div>
        </div>
      `;
    })
    .join("");

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendFriendMessage() {
  const input = document.getElementById("friendChatInput");
  if (
    !input ||
    !currentFriendChat ||
    !currentFriendChat.uid ||
    !auth.currentUser
  )
    return;

  const text = input.value.trim();
  if (!text) return;

  const chatId = getFriendChatId(auth.currentUser.uid, currentFriendChat.uid);
  const messagesRef = collection(db, "friend_chats", chatId, "messages");

  await addDoc(messagesRef, {
    senderUid: auth.currentUser.uid,
    receiverUid: currentFriendChat.uid,
    text,
    timestamp: serverTimestamp(),
  });

  input.value = "";
}

/* --- VẼ BIỂU ĐỒ MOBA RANK --- */
let rankChartInstance = null;

function renderMobaRankChart(eloHistory = state.myEloHistory) {
  const canvas = document.getElementById("mobaRankChart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");
  const data =
    Array.isArray(eloHistory) && eloHistory.length > 0
      ? eloHistory.slice(-10)
      : [state.myElo || 1000];

  const labels = data.map((_, index) => `#${index + 1}`);

  if (rankChartInstance) {
    rankChartInstance.destroy();
    rankChartInstance = null;
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, 90);
  gradient.addColorStop(0, "rgba(250, 204, 21, 0.45)");
  gradient.addColorStop(1, "rgba(250, 204, 21, 0.0)");

  rankChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "ELO Rating",
          data: data,
          borderColor: "#facc15",
          backgroundColor: gradient,
          borderWidth: 2,
          pointBackgroundColor: "#0f172a",
          pointBorderColor: "#facc15",
          pointBorderWidth: 1.5,
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.35,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index",
          intersect: false,
          backgroundColor: "rgba(15, 23, 42, 0.9)",
          callbacks: {
            label: (context) => `ELO: ${context.parsed.y}`,
          },
        },
      },
      scales: {
        x: { display: false },
        y: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: { color: "#94a3b8", font: { size: 10 } },
        },
      },
    },
  });
}
