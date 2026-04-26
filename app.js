/* ══════════════════════════════════════════════════════════
   callit-o — app.js
   Premium Minimalist Communication
══════════════════════════════════════════════════════════ */

// ─── State ─────────────────────────────────────────────────
let currentUser  = null;
let socket       = null;
let peer         = null;
let localStream  = null;
let currentCallId   = null;
let currentCallType = null;
let currentCalleeUid = null;
let callTimerInterval = null;
let callSeconds = 0;
let contacts     = [];
let callLog      = [];
let facingMode   = 'user';
let micEnabled   = true;
let camEnabled   = true;
let speakerEnabled = true;
let iceServers   = [];

// ─── DOM ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── Init ──────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupTheme();
  await loadICEServers();
  setupNavigation();
  setupAuthListeners();
  setupContactModal();
  setupCallControls();
  setupIncomingCallButtons();
});

// ─── Theme Management ──────────────────────────────────────
function setupTheme() {
  const saved = localStorage.getItem('co_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcons(saved);

  $('btnThemeToggle').onclick = () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('co_theme', next);
    updateThemeIcons(next);
  };
}

function updateThemeIcons(theme) {
  if (theme === 'dark') {
    $('moonIcon').classList.add('hidden');
    $('sunIcon').classList.remove('hidden');
  } else {
    $('sunIcon').classList.add('hidden');
    $('moonIcon').classList.remove('hidden');
  }
}

// ─── ICE Servers ───────────────────────────────────────────
async function loadICEServers() {
  try {
    const r = await fetch('https://callit-o-server.onrender.com/ice');
    iceServers = await r.json();
  } catch { iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; }
}

// ─── Auth ──────────────────────────────────────────────────
function setupAuthListeners() {
  $('btnGoogleLogin').onclick = async () => {
    try {
      await fbAuth.signInWithPopup(googleProvider);
    } catch (e) {
      console.error('[Auth Error]', e);
      showToast('Sign-in failed: ' + (e.message || 'Unknown error'));
    }
  };

  $('btnSignOut').onclick = () => {
    if (socket) socket.disconnect();
    fbAuth.signOut();
  };

  fbAuth.onAuthStateChanged(async user => {
    if (user) {
      currentUser = user;
      await ensureUserDoc(user);
      showApp();
      if (!socket) connectSocket(); else if (socket.connected) sendUserOnline();
    } else {
      currentUser = null;
      if (socket) { socket.disconnect(); socket = null; }
      showAuth();
    }
  });
}

async function ensureUserDoc(user) {
  const ref = fbDB.collection('users').doc(user.uid);
  const snap = await ref.get();
  
  if (!snap.exists) {
    let baseId = (user.displayName || 'user').toLowerCase().replace(/\s+/g, '').substring(0, 15);
    let callId = baseId;
    const exists = await fbDB.collection('users').where('callId', '==', callId).get();
    if (!exists.empty) callId = baseId + Math.floor(Math.random() * 1000);

    await ref.set({
      uid: user.uid,
      callId: callId,
      displayName: user.displayName || 'User',
      photoURL: user.photoURL || '',
      email: user.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    const data = snap.data();
    if (!data.callId) {
      let callId = (data.displayName || 'user').toLowerCase().replace(/\s+/g, '').substring(0, 15) + Math.floor(Math.random() * 100);
      await ref.update({ callId: callId });
    }
    await ref.update({
      displayName: user.displayName || data.displayName,
      photoURL: user.photoURL || data.photoURL,
    });
  }
}

function showAuth() {
  $('authScreen').classList.add('active');
  $('appScreen').classList.remove('active');
}

function showApp() {
  $('authScreen').classList.remove('active');
  $('appScreen').classList.add('active');
  renderProfile();
  loadContacts();
  loadCallLog();
}

async function renderProfile() {
  const snap = await fbDB.collection('users').doc(currentUser.uid).get();
  const userData = snap.data();
  $('profileAvatar').src = currentUser.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.displayName)}&background=121212&color=fff`;
  $('profileName').textContent  = currentUser.displayName;
  $('profileEmail').textContent = currentUser.email;
  $('profileUID').textContent   = userData.callId || userData.uid;
  $('btnCopyUID').onclick = () => {
    navigator.clipboard.writeText(userData.callId || userData.uid).then(() => showToast('ID copied!'));
  };
}

// ─── Socket ────────────────────────────────────────────────
function connectSocket() {
  socket = io('https://callit-o-server.onrender.com', { transports: ['websocket', 'polling'] });
  socket.on('connect', () => { sendUserOnline(); });
  socket.on('incoming-call', handleIncomingCall);
  socket.on('call-accepted', handleCallAccepted);
  socket.on('call-rejected', handleCallRejected);
  socket.on('call-ended',    handleCallEnded);
  socket.on('call-failed',   data => showToast(data.reason));
  socket.on('signal',        handleSignal);
}

function sendUserOnline() {
  if (socket && socket.connected && currentUser) {
    socket.emit('user-online', { uid: currentUser.uid, displayName: currentUser.displayName, photoURL: currentUser.photoURL });
  }
}

// ─── Contacts ──────────────────────────────────────────────
async function loadContacts() {
  if (!currentUser) return;
  const snap = await fbDB.collection('users').doc(currentUser.uid).collection('contacts').orderBy('displayName').get();
  contacts = snap.docs.map(d => d.data());
  renderContacts(contacts);
}

function renderContacts(list) {
  const el = $('contactsList');
  if (!list.length) {
    el.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><p>No contacts yet</p></div>';
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="item-row">
      <img class="avatar" src="${c.photoURL || 'https://ui-avatars.com/api/?name='+c.displayName}" alt="">
      <div class="item-info">
        <div class="item-name">${c.displayName}</div>
        <div class="item-meta">${c.callId || 'user'}</div>
      </div>
      <div class="action-btns">
        <button class="btn-circle" onclick="startCall('${c.uid}', '${c.displayName}', '${c.photoURL}', 'voice')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </button>
        <button class="btn-circle" onclick="startCall('${c.uid}', '${c.displayName}', '${c.photoURL}', 'video')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        </button>
      </div>
    </div>`).join('');
}

// ─── Call Log ──────────────────────────────────────────────
function loadCallLog() {
  const stored = localStorage.getItem('co_calllog_' + (currentUser?.uid || ''));
  callLog = stored ? JSON.parse(stored) : [];
  renderCallLog();
}

function renderCallLog() {
  const el = $('callLogList');
  if (!callLog.length) {
    el.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><p>No recent calls</p></div>';
    return;
  }
  el.innerHTML = callLog.map(c => `
    <div class="item-row" onclick="startCall('${c.uid}', '${c.name}', '${c.photo}', 'video')">
      <img class="avatar" src="${c.photo || 'https://ui-avatars.com/api/?name='+c.name}" alt="">
      <div class="item-info">
        <div class="item-name">${c.name}</div>
        <div class="item-meta">${c.type === 'video' ? 'Video' : 'Voice'} · ${c.direction}</div>
      </div>
      <div class="item-meta" style="font-size:11px">${formatTime(c.timestamp)}</div>
    </div>`).join('');
}

// ─── Call Logic ────────────────────────────────────────────
async function startCall(uid, name, photo, type) {
  currentCallId = Math.random().toString(36).substring(2);
  currentCallType = type;
  currentCalleeUid = uid;
  try {
    localStream = await getMedia(type);
    showCallScreen(name, type);
    socket.emit('call-user', { calleeUid: uid, callType: type, callId: currentCallId });
    addCallLogEntry({ uid, name, photo, type, direction: 'Outgoing', timestamp: Date.now() });
  } catch { showToast('Media access denied'); }
}

async function getMedia(type) {
  return navigator.mediaDevices.getUserMedia({
    video: type === 'video' ? { facingMode, width: 1280, height: 720 } : false,
    audio: { echoCancellation: true, noiseSuppression: true }
  });
}

function handleIncomingCall(data) {
  currentCallId = data.callId;
  currentCallType = data.callType;
  currentCalleeUid = data.callerUid;
  $('incomingPhoto').src = data.callerPhoto || '';
  $('incomingName').textContent = data.callerName;
  showModal('incomingScreen');
  playRingTone(true);
}

function setupIncomingCallButtons() {
  $('btnAcceptCall').onclick = async () => {
    playRingTone(false);
    hideModal('incomingScreen');
    localStream = await getMedia(currentCallType);
    socket.emit('accept-call', { callId: currentCallId });
    showCallScreen($('incomingName').textContent, currentCallType);
    addCallLogEntry({ uid: currentCalleeUid, name: $('incomingName').textContent, type: currentCallType, direction: 'Incoming', timestamp: Date.now() });
  };
  $('btnRejectCall').onclick = () => {
    playRingTone(false);
    hideModal('incomingScreen');
    socket.emit('reject-call', { callId: currentCallId });
  };
}

function handleCallAccepted() { $('callBarStatus').textContent = 'Connected'; createPeer(true); }
function handleCallRejected() { showToast('Call declined'); endCallCleanup(); }
function handleCallEnded() { showToast('Call ended'); endCallCleanup(); }

function createPeer(initiator) {
  peer = new SimplePeer({ initiator, stream: localStream, trickle: true, config: { iceServers } });
  peer.on('signal', signal => socket.emit('signal', { callId: currentCallId, signal }));
  peer.on('stream', stream => { $('remoteVideo').srcObject = stream; $('callBarStatus').textContent = 'Live'; });
  peer.on('close', endCallCleanup);
}

function handleSignal(data) {
  if (!peer) createPeer(false);
  peer.signal(data.signal);
}

function showCallScreen(name, type) {
  $('callBarName').textContent = name;
  $('callBarStatus').textContent = 'Connecting…';
  if (type === 'video') $('localVideo').srcObject = localStream;
  $('callScreen').classList.add('active');
}

function setupCallControls() {
  $('btnEndCall').onclick = () => { socket.emit('end-call', { callId: currentCallId }); endCallCleanup(); };
  $('btnToggleMic').onclick = () => { micEnabled = !micEnabled; localStream.getAudioTracks()[0].enabled = micEnabled; $('btnToggleMic').classList.toggle('active', !micEnabled); };
  $('btnToggleCam').onclick = () => { camEnabled = !camEnabled; localStream.getVideoTracks()[0].enabled = camEnabled; $('btnToggleCam').classList.toggle('active', !camEnabled); };
  $('btnFlipCam').onclick = async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    localStream.getVideoTracks()[0].stop();
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
    const track = s.getVideoTracks()[0];
    peer.replaceTrack(localStream.getVideoTracks()[0], track, localStream);
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(track);
    $('localVideo').srcObject = localStream;
  };
}

function endCallCleanup() {
  playRingTone(false);
  if (peer) peer.destroy(); peer = null;
  if (localStream) localStream.getTracks().forEach(t => t.stop()); localStream = null;
  $('callScreen').classList.remove('active');
  hideModal('incomingScreen');
  
  // Prompt to add contact logic (as previously implemented)
  checkAddContact(currentCalleeUid);
}

async function checkAddContact(uid) {
  if (!uid) return;
  const isKnown = contacts.some(c => c.uid === uid);
  if (!isKnown) {
    const snap = await fbDB.collection('users').doc(uid).get();
    if (snap.exists) {
      const u = snap.data();
      // Show your post-call modal here
    }
  }
}

// ─── Navigation ────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  $('btnHeaderAction').onclick = () => {
    const tab = document.querySelector('.nav-btn.active').dataset.tab;
    if (tab === 'contacts' || tab === 'calls') showModal('modalAddContact');
  };
}

function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');
  $('headerTitle').textContent = tab === 'profile' ? 'Settings' : tab.charAt(0).toUpperCase() + tab.slice(1);
  $('searchContainer').classList.toggle('hidden', tab !== 'contacts');
}

// ─── Modals ────────────────────────────────────────────────
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }
function showToast(m) { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 3000); }
function formatTime(ts) { const d = new Date(ts); return d.getHours()+':'+d.getMinutes().toString().padStart(2,'0'); }
function addCallLogEntry(e) { callLog.unshift(e); localStorage.setItem('co_calllog_'+currentUser.uid, JSON.stringify(callLog.slice(0,50))); renderCallLog(); }

// ─── Contact Modal ─────────────────────────────────────────
function setupContactModal() {
  $('btnSearchUID').onclick = async () => {
    const sid = $('addContactUID').value.trim().toLowerCase();
    let snap = await fbDB.collection('users').where('callId', '==', sid).get();
    if (snap.empty) { showToast('Not found'); return; }
    const user = snap.docs[0].data();
    $('addContactPhoto').src = user.photoURL || '';
    $('addContactName').textContent = user.displayName;
    $('addContactUID2').textContent = user.callId;
    $('addContactResult').classList.remove('hidden');
    $('btnConfirmAdd').onclick = async () => {
      await fbDB.collection('users').doc(currentUser.uid).collection('contacts').doc(user.uid).set(user);
      showToast('Added!');
      hideModal('modalAddContact');
      loadContacts();
    };
  };
}

// Ringtone logic (re-used from previous)
let ringCtx = null, ringOsc = null;
function playRingTone(on) {
  if (on) {
    ringCtx = new AudioContext();
    ringOsc = setInterval(() => {
      const o = ringCtx.createOscillator(); const g = ringCtx.createGain();
      o.connect(g); g.connect(ringCtx.destination);
      o.frequency.value = 440; g.gain.exponentialRampToValueAtTime(0.01, ringCtx.currentTime+0.5);
      o.start(); o.stop(ringCtx.currentTime+0.5);
    }, 2000);
  } else { clearInterval(ringOsc); if(ringCtx) ringCtx.close(); }
}
