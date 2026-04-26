/* ══════════════════════════════════════════════════════════
   callit-o — app.js
   WhatsApp-style direct video & voice call app
══════════════════════════════════════════════════════════ */

// ─── State ─────────────────────────────────────────────────
let currentUser  = null;
let socket       = null;
let peer         = null;       // SimplePeer instance
let localStream  = null;
let currentCallId   = null;
let currentCallType = null;    // 'video' | 'voice'
let currentCalleeUid = null;
let callTimerInterval = null;
let callSeconds = 0;
let contacts     = [];         // [{uid, displayName, photoURL}]
let callLog      = [];         // [{uid, name, photo, type, direction, timestamp, duration}]
let activeContactTarget = null; // contact being dialed from modal
let facingMode   = 'user';
let micEnabled   = true;
let camEnabled   = true;
let speakerEnabled = true;
let iceServers   = [];

// ─── DOM ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── Init ──────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await loadICEServers();
  setupNavigation();
  setupAuthListeners();
  setupContactModal();
  setupCallModal();
  setupCallControls();
  setupIncomingCallButtons();
});

// ─── ICE Servers ───────────────────────────────────────────
async function loadICEServers() {
  try {
    const r = await fetch('/ice');
    iceServers = await r.json();
  } catch { iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; }
}

// ─── Auth ──────────────────────────────────────────────────
function setupAuthListeners() {
  $('btnGoogleLogin').addEventListener('click', async () => {
    try {
      await fbAuth.signInWithPopup(googleProvider);
    } catch (e) {
      showToast('Sign-in failed. Please try again.');
    }
  });

  $('btnSignOut').addEventListener('click', () => {
    if (socket) socket.disconnect();
    fbAuth.signOut();
  });

  fbAuth.onAuthStateChanged(async user => {
    if (user) {
      currentUser = user;
      await ensureUserDoc(user);
      showApp();
      connectSocket();
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
    await ref.set({
      uid:         user.uid,
      displayName: user.displayName || 'User',
      photoURL:    user.photoURL    || '',
      email:       user.email       || '',
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    await ref.update({
      displayName: user.displayName || snap.data().displayName,
      photoURL:    user.photoURL    || snap.data().photoURL,
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

function renderProfile() {
  const u = currentUser;
  $('profileAvatar').src = u.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.displayName || 'U') + '&background=6C63FF&color=fff';
  $('profileName').textContent  = u.displayName || 'User';
  $('profileEmail').textContent = u.email || '';
  $('profileUID').textContent   = u.uid;

  $('btnCopyUID').addEventListener('click', () => {
    navigator.clipboard.writeText(u.uid).then(() => showToast('UID copied!'));
  });
}

// ─── Socket ────────────────────────────────────────────────
function connectSocket() {
  const SERVER = window.location.origin;
  socket = io(SERVER, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    socket.emit('user-online', {
      uid:         currentUser.uid,
      displayName: currentUser.displayName,
      photoURL:    currentUser.photoURL
    });
  });

  socket.on('incoming-call', handleIncomingCall);
  socket.on('call-accepted', handleCallAccepted);
  socket.on('call-rejected', handleCallRejected);
  socket.on('call-ended',    handleCallEnded);
  socket.on('call-failed',   data => { showToast(data.reason || 'Call failed'); });
  socket.on('signal',        handleSignal);

  socket.on('disconnect', () => console.log('[socket] disconnected'));
}

// ─── Contact Helpers ───────────────────────────────────────
function getAvatarURL(photoURL, name) {
  return photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'U')}&background=6C63FF&color=fff`;
}

// ─── Contacts (Firestore) ──────────────────────────────────
async function loadContacts() {
  if (!currentUser) return;
  const snap = await fbDB.collection('users')
    .doc(currentUser.uid)
    .collection('contacts')
    .orderBy('displayName')
    .get();

  contacts = snap.docs.map(d => d.data());
  renderContacts(contacts);
}

function renderContacts(list) {
  const el = $('contactsList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      <p>No contacts yet</p><span>Add someone using their UID</span></div>`;
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="contact-item" data-uid="${c.uid}">
      <div class="avatar-wrap">
        <img class="ci-avatar" src="${getAvatarURL(c.photoURL, c.displayName)}" alt="${c.displayName}">
        <div class="online-dot" id="dot-${c.uid}"></div>
      </div>
      <div class="ci-info">
        <div class="ci-name">${c.displayName}</div>
        <div class="ci-meta" style="color:var(--tx3);font-size:11px;margin-top:2px">${c.uid.substring(0,12)}…</div>
      </div>
      <div class="contact-actions">
        <button class="contact-call-btn voice" data-uid="${c.uid}" data-name="${c.displayName}" data-photo="${c.photoURL||''}" data-action="voice" title="Voice Call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.22 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92z"/></svg>
        </button>
        <button class="contact-call-btn video" data-uid="${c.uid}" data-name="${c.displayName}" data-photo="${c.photoURL||''}" data-action="video" title="Video Call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        </button>
      </div>
    </div>`).join('');

  // Bind call buttons
  el.querySelectorAll('.contact-call-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { uid, name, photo, action } = btn.dataset;
      startCall(uid, name, photo, action);
    });
  });

  // Check online status
  list.forEach(c => checkOnline(c.uid));
}

function checkOnline(uid) {
  if (!socket) return;
  socket.emit('check-online', uid, ({ online }) => {
    const dot = document.getElementById('dot-' + uid);
    if (dot) dot.classList.toggle('show', online);
  });
}

// ─── Contact Search Bar ────────────────────────────────────
$('contactSearch').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const filtered = contacts.filter(c =>
    c.displayName.toLowerCase().includes(q) || c.uid.toLowerCase().includes(q)
  );
  renderContacts(filtered);
});

// ─── Add Contact Modal ─────────────────────────────────────
function setupContactModal() {
  $('btnAddContact').addEventListener('click',       () => showModal('modalAddContact'));
  $('btnCloseAddContact').addEventListener('click',  () => hideModal('modalAddContact'));
  $('modalAddContact').addEventListener('click', e => { if(e.target === $('modalAddContact')) hideModal('modalAddContact'); });

  let foundUser = null;

  $('btnSearchUID').addEventListener('click', async () => {
    const uid = $('addContactUID').value.trim();
    if (!uid) { showToast('Enter a UID'); return; }
    if (uid === currentUser.uid) { showToast("That's your own UID!"); return; }

    foundUser = null;
    $('addContactResult').classList.add('hidden');
    $('addContactError').classList.add('hidden');
    $('btnConfirmAdd').classList.add('hidden');

    try {
      const snap = await fbDB.collection('users').doc(uid).get();
      if (!snap.exists) throw new Error('Not found');
      foundUser = snap.data();
      $('addContactPhoto').src = getAvatarURL(foundUser.photoURL, foundUser.displayName);
      $('addContactName').textContent = foundUser.displayName;
      $('addContactUID2').textContent = foundUser.uid;
      $('addContactResult').classList.remove('hidden');
      $('btnConfirmAdd').classList.remove('hidden');
    } catch {
      $('addContactError').classList.remove('hidden');
    }
  });

  $('btnConfirmAdd').addEventListener('click', async () => {
    if (!foundUser) return;
    try {
      await fbDB.collection('users').doc(currentUser.uid)
        .collection('contacts').doc(foundUser.uid).set(foundUser);
      showToast(`${foundUser.displayName} added!`);
      hideModal('modalAddContact');
      $('addContactUID').value = '';
      $('addContactResult').classList.add('hidden');
      $('btnConfirmAdd').classList.add('hidden');
      loadContacts();
    } catch { showToast('Failed to add contact.'); }
  });
}

// ─── Call Log ──────────────────────────────────────────────
function loadCallLog() {
  const stored = localStorage.getItem('dc_calllog_' + (currentUser?.uid || ''));
  callLog = stored ? JSON.parse(stored) : [];
  renderCallLog();
}

function saveCallLog() {
  localStorage.setItem('dc_calllog_' + (currentUser?.uid || ''), JSON.stringify(callLog.slice(0, 50)));
}

function addCallLogEntry(entry) {
  callLog.unshift(entry);
  saveCallLog();
  renderCallLog();
}

function renderCallLog() {
  const el = $('callLogList');
  if (!callLog.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.22 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92z"/><path d="M1 1l22 22"/></svg>
      <p>No recent calls yet</p><span>Call a contact to get started</span></div>`;
    return;
  }
  el.innerHTML = callLog.map(c => {
    const dirIcon = c.direction === 'missed'
      ? `<span class="ci-missed">↙ Missed</span>`
      : c.direction === 'outgoing'
        ? `<span>↗ Outgoing</span>`
        : `<span>↙ Incoming</span>`;
    const typeIcon = c.type === 'video' ? '📹' : '📞';
    return `<div class="call-item" data-uid="${c.uid}" data-name="${c.name}" data-photo="${c.photo||''}">
      <img class="ci-avatar" src="${getAvatarURL(c.photo, c.name)}" alt="${c.name}">
      <div class="ci-info">
        <div class="ci-name ${c.direction==='missed'?'ci-missed':''}">${c.name}</div>
        <div class="ci-meta">${typeIcon} ${dirIcon}${c.duration?' · '+c.duration:''}</div>
      </div>
      <div class="ci-time">${formatTime(c.timestamp)}</div>
    </div>`;
  }).join('');

  // Tap call log item → open call modal
  el.querySelectorAll('.call-item').forEach(item => {
    item.addEventListener('click', () => {
      const { uid, name, photo } = item.dataset;
      openCallModal(uid, name, photo);
    });
  });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2,'0');
  const s = (secs % 60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

// ─── Call Modal ────────────────────────────────────────────
function setupCallModal() {
  $('btnCloseCallModal').addEventListener('click', () => hideModal('modalCallContact'));
  $('modalCallContact').addEventListener('click', e => { if(e.target === $('modalCallContact')) hideModal('modalCallContact'); });
  $('btnVoiceCall').addEventListener('click', () => {
    if (!activeContactTarget) return;
    hideModal('modalCallContact');
    startCall(activeContactTarget.uid, activeContactTarget.name, activeContactTarget.photo, 'voice');
  });
  $('btnVideoCall').addEventListener('click', () => {
    if (!activeContactTarget) return;
    hideModal('modalCallContact');
    startCall(activeContactTarget.uid, activeContactTarget.name, activeContactTarget.photo, 'video');
  });

  // New call btn (from header) → opens add contact or shows contacts tab
  $('btnNewCall').addEventListener('click', () => switchTab('contacts'));
}

function openCallModal(uid, name, photo) {
  activeContactTarget = { uid, name, photo };
  $('modalCallName').textContent  = name;
  $('modalCallPhoto').src = getAvatarURL(photo, name);
  showModal('modalCallContact');
}

// ─── Starting a Call ───────────────────────────────────────
async function startCall(uid, name, photo, callType) {
  if (!socket || !currentUser) { showToast('Not connected'); return; }

  currentCallId   = generateCallId();
  currentCallType = callType;
  currentCalleeUid = uid;

  // Get media
  try {
    localStream = await getMedia(callType);
  } catch (e) {
    showToast('Camera/mic access denied');
    return;
  }

  socket.emit('call-user', { calleeUid: uid, callType, callId: currentCallId });

  showCallScreen(name, photo, callType, true);
  $('callBarStatus').textContent = 'Ringing…';

  // Log as outgoing (pending)
  addCallLogEntry({ uid, name, photo, type: callType, direction: 'outgoing', timestamp: Date.now() });
}

async function getMedia(callType) {
  const constraints = callType === 'video'
    ? { video: { facingMode }, audio: true }
    : { video: false, audio: true };
  return navigator.mediaDevices.getUserMedia(constraints);
}

// ─── Incoming Call ─────────────────────────────────────────
function handleIncomingCall(data) {
  const { callId, callType, callerUid, callerName, callerPhoto } = data;

  // Play ringing sound
  playRingTone(true);

  currentCallId    = callId;
  currentCallType  = callType;
  currentCalleeUid = callerUid;

  $('incomingPhoto').src = getAvatarURL(callerPhoto, callerName);
  $('incomingName').textContent = callerName;
  $('incomingType').textContent = callType === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Voice Call';

  $('incomingScreen').classList.remove('hidden');
}

function setupIncomingCallButtons() {
  $('btnAcceptCall').addEventListener('click', async () => {
    playRingTone(false);
    $('incomingScreen').classList.add('hidden');

    try {
      localStream = await getMedia(currentCallType);
    } catch {
      showToast('Camera/mic access denied');
      socket.emit('reject-call', { callId: currentCallId, reason: 'no-media' });
      currentCallId = null;
      return;
    }

    socket.emit('accept-call', { callId: currentCallId });

    const callerName  = $('incomingName').textContent;
    const callerPhoto = $('incomingPhoto').src;

    showCallScreen(callerName, callerPhoto, currentCallType, false);

    // Log incoming
    addCallLogEntry({ uid: currentCalleeUid, name: callerName, photo: callerPhoto, type: currentCallType, direction: 'incoming', timestamp: Date.now() });
  });

  $('btnRejectCall').addEventListener('click', () => {
    playRingTone(false);
    $('incomingScreen').classList.add('hidden');
    socket.emit('reject-call', { callId: currentCallId, reason: 'declined' });

    // Log missed by callee side → mark incoming as missed for the caller
    currentCallId = null;
  });
}

// ─── Call Accepted (caller side) ──────────────────────────
function handleCallAccepted(data) {
  $('callBarStatus').textContent = 'Connected';
  startCallTimer();

  // Caller creates peer (initiator)
  createPeer(true);
}

// ─── Call Rejected ─────────────────────────────────────────
function handleCallRejected(data) {
  showToast('Call declined');
  endCallCleanup();
}

// ─── Call Ended ────────────────────────────────────────────
function handleCallEnded(data) {
  showToast('Call ended');
  endCallCleanup();
}

// ─── WebRTC Peer ───────────────────────────────────────────
function createPeer(initiator) {
  peer = new SimplePeer({
    initiator,
    stream: localStream,
    trickle: true,
    config: { iceServers }
  });

  peer.on('signal', signal => {
    socket.emit('signal', { callId: currentCallId, signal });
  });

  peer.on('stream', stream => {
    $('remoteVideo').srcObject = stream;
    $('callBarStatus').textContent = 'Connected';
    if (!initiator) startCallTimer(); // callee starts timer on stream
  });

  peer.on('error', err => { console.error('[peer]', err); endCallCleanup(); });
  peer.on('close', () => endCallCleanup());
}

function handleSignal(data) {
  if (!peer) {
    // Callee creates peer on first signal
    createPeer(false);
  }
  try { peer.signal(data.signal); } catch(e) { console.error(e); }
}

// ─── Call Screen UI ────────────────────────────────────────
function showCallScreen(name, photo, callType, isInitiator) {
  $('callBarName').textContent = name;
  $('callBarStatus').textContent = isInitiator ? 'Ringing…' : 'Connecting…';

  if (callType === 'video') {
    $('localVideo').srcObject  = localStream;
    $('audioCallOverlay').classList.add('hidden');
  } else {
    $('audioCallOverlay').classList.remove('hidden');
    $('callPeerPhoto').src = getAvatarURL(photo, name);
    $('callPeerName').textContent = name;
    $('callTimer').textContent = '00:00';
    $('localVideo').style.display = 'none';
  }

  $('callScreen').classList.remove('hidden');
}

// ─── Call Controls ─────────────────────────────────────────
function setupCallControls() {
  $('btnToggleMic').addEventListener('click', () => {
    micEnabled = !micEnabled;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    $('btnToggleMic').classList.toggle('active', !micEnabled);
  });

  $('btnToggleCam').addEventListener('click', () => {
    camEnabled = !camEnabled;
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    $('btnToggleCam').classList.toggle('active', !camEnabled);
  });

  $('btnFlipCam').addEventListener('click', async () => {
    if (currentCallType !== 'video') return;
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    if (localStream) localStream.getVideoTracks().forEach(t => t.stop());
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
      const newTrack  = newStream.getVideoTracks()[0];
      if (peer) {
        const sender = peer._pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(newTrack);
      }
      localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
      localStream.addTrack(newTrack);
      $('localVideo').srcObject = localStream;
    } catch(e) { showToast('Camera flip failed'); }
  });

  $('btnToggleSpeaker').addEventListener('click', () => {
    speakerEnabled = !speakerEnabled;
    $('remoteVideo').muted = !speakerEnabled;
    $('btnToggleSpeaker').classList.toggle('active', !speakerEnabled);
  });

  $('btnEndCall').addEventListener('click', () => {
    socket.emit('end-call', { callId: currentCallId });
    endCallCleanup();
  });
}

// ─── End / Cleanup ─────────────────────────────────────────
function endCallCleanup() {
  stopCallTimer();
  playRingTone(false);

  if (peer)        { try{ peer.destroy(); }catch{} peer = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject  = null;
  $('localVideo').style.display = '';
  $('callScreen').classList.add('hidden');
  $('incomingScreen').classList.add('hidden');

  micEnabled = true; camEnabled = true; speakerEnabled = true;
  $('btnToggleMic').classList.remove('active');
  $('btnToggleCam').classList.remove('active');
  $('btnToggleSpeaker').classList.remove('active');

  currentCallId = null; currentCallType = null; currentCalleeUid = null;
}

// ─── Timer ─────────────────────────────────────────────────
function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const d = formatDuration(callSeconds);
    $('callBarStatus').textContent = d;
    if ($('callTimer')) $('callTimer').textContent = d;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  const dur = callSeconds > 0 ? formatDuration(callSeconds) : '';
  if (callLog.length && !callLog[0].duration) {
    callLog[0].duration = dur;
    saveCallLog();
  }
  callSeconds = 0;
}

// ─── Ringtone ──────────────────────────────────────────────
let ringCtx = null, ringOscNode = null;
function playRingTone(on) {
  if (on) {
    try {
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      function beep() {
        const osc = ringCtx.createOscillator();
        const gain = ringCtx.createGain();
        osc.connect(gain); gain.connect(ringCtx.destination);
        osc.frequency.value = 480;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ringCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ringCtx.currentTime + 0.5);
        osc.start(ringCtx.currentTime);
        osc.stop(ringCtx.currentTime + 0.5);
      }
      beep();
      ringOscNode = setInterval(beep, 2000);
    } catch {}
  } else {
    clearInterval(ringOscNode);
    if (ringCtx) { ringCtx.close(); ringCtx = null; }
  }
}

// ─── Navigation ────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'contacts') {
    contacts.forEach(c => checkOnline(c.uid));
  }
}

// ─── Modals ────────────────────────────────────────────────
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }

// ─── Toast ─────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

// ─── Helpers ───────────────────────────────────────────────
function generateCallId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
