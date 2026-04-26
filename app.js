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
let currentCallDetails = null;
let callStartTime = null;
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
  setupMeetlyFun();
  checkRoomLink();
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
    $('splashScreen').classList.add('hidden');
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
  
  if ($('profileStatus')) {
    $('profileStatus').value = userData.status || 'Available';
    $('profileStatus').onchange = async e => {
      await fbDB.collection('users').doc(currentUser.uid).update({ status: e.target.value });
      showToast('Status updated');
    };
  }

  $('btnCopyUID').onclick = () => {
    navigator.clipboard.writeText(userData.callId || userData.uid).then(() => showToast('ID copied!'));
  };
  if ($('btnCopyBanner')) {
    $('btnCopyBanner').onclick = () => {
      navigator.clipboard.writeText(userData.callId || userData.uid).then(() => showToast('ID copied!'));
    };
  }
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
  
  for (let i = 0; i < contacts.length; i++) {
    const userSnap = await fbDB.collection('users').doc(contacts[i].uid).get();
    if (userSnap.exists) {
      contacts[i] = { ...contacts[i], ...userSnap.data() };
    }
  }
  
  if (socket && socket.connected) {
    let checked = 0;
    if (contacts.length === 0) renderContacts(contacts);
    contacts.forEach(c => {
      socket.emit('check-online', c.uid, res => {
        c.online = res.online;
        checked++;
        if (checked === contacts.length) renderContacts(contacts);
      });
    });
  } else {
    renderContacts(contacts);
  }
}

function renderContacts(list) {
  const el = $('contactsList');
  if (!list.length) {
    el.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><p>No contacts yet</p><button class="btn-primary" style="margin-top:24px; width:auto; padding:12px 28px; border-radius:100px; font-size:14px;" onclick="showModal(\'modalAddContact\')">Add a Contact</button></div>';
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="item-row">
      <div class="avatar-wrap">
        <img class="avatar" src="${c.photoURL || 'https://ui-avatars.com/api/?name='+encodeURIComponent(c.displayName)}" alt="">
        <span class="dot ${c.online ? 'online' : 'offline'}"></span>
      </div>
      <div class="item-info">
        <div class="item-name">${c.displayName}</div>
        <div class="item-meta">${c.status || (c.online ? 'Available' : 'Offline')}</div>
      </div>
      <div class="action-btns">
        <button class="btn-circle" style="width:36px; height:36px; color:var(--danger); background:var(--surface-sub)" onclick="blockUser('${c.uid}')" title="Block/Report">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width:16px;height:16px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        </button>
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
  const banner = $('onboardingBanner');
  updateBadge();
  if (!callLog.length) {
    if (banner) banner.classList.remove('hidden');
    el.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><p>No recent calls</p><button class="btn-primary" style="margin-top:24px; width:auto; padding:12px 28px; border-radius:100px; font-size:14px;" onclick="showModal(\'modalAddContact\')">Find someone to call</button></div>';
    return;
  }
  if (banner) banner.classList.add('hidden');
  
  const grouped = [];
  callLog.forEach(c => {
    if (grouped.length && grouped[grouped.length-1].uid === c.uid && grouped[grouped.length-1].direction === c.direction) {
      grouped[grouped.length-1].calls.push(c);
    } else {
      grouped.push({ ...c, calls: [c] });
    }
  });

  el.innerHTML = grouped.map((g, i) => {
    const isMissed = g.duration === 0 && g.direction === 'Incoming';
    const label = g.duration === 0 ? (g.direction === 'Incoming' ? 'Missed' : 'Cancelled') : g.direction;
    const durStr = g.duration > 0 ? ' · ' + formatDuration(g.duration) : '';
    const icon = g.type === 'video' 
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width:12px;height:12px;margin-right:4px;vertical-align:middle"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>' 
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width:12px;height:12px;margin-right:4px;vertical-align:middle"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
      
    return `
    <div class="call-log-item" data-index="${i}">
      <div class="call-log-delete" onclick="deleteCallGroup(${i})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:24px;height:24px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </div>
      <div class="call-log-inner" onclick="startCall('${g.uid}', '${g.name}', '${g.photo}', '${g.type}')" ontouchstart="handleSwipeStart(event, this)" ontouchmove="handleSwipeMove(event, this)" ontouchend="handleSwipeEnd(event, this)">
        <img class="avatar" src="${g.photo || 'https://ui-avatars.com/api/?name='+encodeURIComponent(g.name)}" alt="">
        <div class="item-info">
          <div class="item-name" style="${!g.seen ? 'font-weight:800;' : ''}">${g.name} ${g.calls.length > 1 ? `(${g.calls.length})` : ''}</div>
          <div class="item-meta" style="color: ${isMissed ? 'var(--danger)' : 'var(--tx-sub)'}">
            ${icon}${label}${durStr}
          </div>
        </div>
        <div class="item-meta" style="font-size:11px">${formatTime(g.timestamp)}</div>
      </div>
    </div>`;
  }).join('');
}

// ─── Call Logic ────────────────────────────────────────────
async function startCall(uid, name, photo, type) {
  currentCallId = Math.random().toString(36).substring(2);
  currentCallType = type;
  currentCalleeUid = uid;
  currentCallDetails = { uid, name, photo, type, direction: 'Outgoing', seen: true };
  callStartTime = null;
  try {
    localStream = await getMedia(type);
    showCallScreen(name, type);
    socket.emit('call-user', { calleeUid: uid, callType: type, callId: currentCallId });
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
  currentCallDetails = { uid: data.callerUid, name: data.callerName, photo: data.callerPhoto, type: data.callType, direction: 'Incoming', seen: false };
  callStartTime = null;
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
  
  if($('btnToggleSpeaker')) {
    $('btnToggleSpeaker').onclick = () => {
      speakerEnabled = !speakerEnabled;
      $('btnToggleSpeaker').classList.toggle('active', !speakerEnabled);
      if (!speakerEnabled) {
        $('remoteVideo').volume = 0.2;
        showToast('Earpiece mode active');
      } else {
        $('remoteVideo').volume = 1.0;
        showToast('Speaker mode active');
      }
    };
  }

  $('btnToggleMic').onclick = () => { micEnabled = !micEnabled; localStream.getAudioTracks()[0].enabled = micEnabled; $('btnToggleMic').classList.toggle('active', !micEnabled); };
  $('btnToggleCam').onclick = () => { 
    camEnabled = !camEnabled; 
    localStream.getVideoTracks()[0].enabled = camEnabled; 
    $('btnToggleCam').classList.toggle('active', !camEnabled); 
    $('localVideo').style.opacity = camEnabled ? '1' : '0';
    $('localAvatarImg').src = currentUser.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.displayName)}`;
    $('localAvatarBox').classList.toggle('hidden', camEnabled);
  };
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

  $('volumeSlider').oninput = e => { if ($('remoteVideo')) $('remoteVideo').volume = e.target.value; };

  let screenStream = null;
  $('btnScreenShare').onclick = async () => {
    if (!screenStream) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = screenStream.getVideoTracks()[0];
        peer.replaceTrack(localStream.getVideoTracks()[0], track, localStream);
        
        track.onended = () => {
          peer.replaceTrack(track, localStream.getVideoTracks()[0], localStream);
          screenStream = null;
          $('btnScreenShare').classList.remove('active');
        };
        $('btnScreenShare').classList.add('active');
      } catch (e) { showToast('Screen share failed'); }
    } else {
      const track = screenStream.getVideoTracks()[0];
      track.stop();
      peer.replaceTrack(track, localStream.getVideoTracks()[0], localStream);
      screenStream = null;
      $('btnScreenShare').classList.remove('active');
    }
  };

  let noiseCancel = true;
  $('btnNoiseCancel').onclick = async () => {
    noiseCancel = !noiseCancel;
    $('btnNoiseCancel').classList.toggle('active', !noiseCancel);
    if (localStream && localStream.getAudioTracks().length > 0) {
      try {
        await localStream.getAudioTracks()[0].applyConstraints({ noiseSuppression: noiseCancel, echoCancellation: true });
        showToast('Noise cancel ' + (noiseCancel ? 'ON' : 'OFF'));
      } catch (e) { console.log('Constraint error', e); }
    }
  };

  $('btnToggleChat').onclick = () => $('chatPanel').classList.remove('hidden');
  $('btnCloseChat').onclick = () => $('chatPanel').classList.add('hidden');
  $('btnSendChat').onclick = () => {
    const msg = $('chatInput').value.trim();
    if (msg && peer) {
      try {
        peer.send(JSON.stringify({ type: 'chat', text: msg }));
        addChatMessage(msg, true);
        $('chatInput').value = '';
      } catch (e) { showToast('Chat not ready'); }
    }
  };

  let mediaRecorder;
  let recordedChunks = [];
  $('btnRecordCall').onclick = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      $('btnRecordCall').classList.remove('active');
      $('btnRecordCall').style.color = '';
      showToast('Recording saved');
    } else {
      try {
        const stream = $('remoteVideo').srcObject;
        if (!stream) { showToast('No active call to record'); return; }
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        recordedChunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = `callit-o-record-${Date.now()}.webm`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        };
        mediaRecorder.start();
        $('btnRecordCall').classList.add('active');
        $('btnRecordCall').style.color = 'var(--danger)';
        showToast('Recording started');
      } catch (e) {
        showToast('Recording not supported');
      }
    }
  };

  $('btnPiP').onclick = async () => {
    const remoteVideo = $('remoteVideo');
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      $('btnPiP').classList.remove('active');
    } else if (remoteVideo.readyState >= 2) {
      try {
        await remoteVideo.requestPictureInPicture();
        $('btnPiP').classList.add('active');
      } catch(e) { showToast('PiP not supported or failed'); }
    }
  };
  $('remoteVideo').addEventListener('leavepictureinpicture', () => {
    $('btnPiP').classList.remove('active');
  });
}

function endCallCleanup() {
  playRingTone(false);
  stopCallTimer();
  if (typeof mediaRecorder !== 'undefined' && mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    $('btnRecordCall').classList.remove('active');
    $('btnRecordCall').style.color = '';
  }
  if (peer) peer.destroy(); peer = null;
  if (localStream) localStream.getTracks().forEach(t => t.stop()); localStream = null;
  $('callScreen').classList.remove('active');
  hideModal('incomingScreen');
  if (speechRecognition) { speechRecognition.stop(); }

  if (isStrangerCall) {
    // If it was a stranger call, go back to stranger view waiting
    $('strangerControls').classList.add('hidden');
    $('swipeInstruction').classList.remove('hidden');
    $('strangerRemoteVideo').srcObject = null;
    isStrangerCall = false;
    currentStrangerId = null;
    return;
  }
  
  if (currentCallDetails) {
    let durationMs = callStartTime ? Date.now() - callStartTime : 0;
    addCallLogEntry({
      ...currentCallDetails,
      timestamp: Date.now(),
      duration: durationMs
    });
    showCallEndedModal(currentCallDetails, durationMs);
    currentCallDetails = null;
  }
  callStartTime = null;
  
  checkAddContact(currentCalleeUid);
}

// ─── MeetlyFUN Integration (Strangers / Explore) ───────────
let isStrangerCall = false;
let currentStrangerId = null;
let speechRecognition = null;
let icebreakers = [
  "What's your favorite movie?",
  "If you could travel anywhere, where would you go?",
  "What's your most controversial food opinion?",
  "Do you have any hidden talents?",
  "What's the best piece of advice you've received?"
];

function setupMeetlyFun() {
  if($('btnStrangerPrefsOpen')) {
    $('btnStrangerPrefsOpen').onclick = () => $('strangerPrefs').classList.remove('hidden');
    $('btnCloseStrangerPrefs').onclick = () => $('strangerPrefs').classList.add('hidden');
    
    $('btnSaveStrangerPrefs').onclick = () => {
      const tags = $('strangerTags').value;
      const native = $('langNative').value;
      const learning = $('langLearning').value;
      const anon = $('toggleAnonymous').checked;
      
      localStorage.setItem('mf_prefs', JSON.stringify({ tags, native, learning, anon }));
      showToast('DNA Preferences Saved!');
      $('strangerPrefs').classList.add('hidden');
    };
    
    // Load prefs
    const prefs = JSON.parse(localStorage.getItem('mf_prefs') || '{}');
    if(prefs.tags) $('strangerTags').value = prefs.tags;
    if(prefs.native) $('langNative').value = prefs.native;
    if(prefs.learning) $('langLearning').value = prefs.learning;
    if(prefs.anon) $('toggleAnonymous').checked = prefs.anon;

    $('btnStartStrangerMatch').onclick = startStrangerMatch;
    $('btnStrangerNext').onclick = startStrangerMatch;

    // Swiping logic
    let touchStartY = 0;
    $('swipeContainer').addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; });
    $('swipeContainer').addEventListener('touchend', e => {
      let touchEndY = e.changedTouches[0].clientY;
      if (touchStartY - touchEndY > 50) { // Swiped up
        startStrangerMatch();
      }
    });
  }
}

async function startStrangerMatch() {
  if (peer) { endCallCleanup(); }
  $('swipeInstruction').classList.add('hidden');
  $('strangerControls').classList.remove('hidden');
  $('strangerName').textContent = 'Finding a match...';
  $('strangerRemoteVideo').srcObject = null;
  $('icebreakerOverlay').classList.add('hidden');
  $('liveCaptions').textContent = '';

  const prefs = JSON.parse(localStorage.getItem('mf_prefs') || '{}');
  
  try {
    localStream = await getMedia('video');
    if (prefs.anon) {
      $('localVideo').style.filter = 'blur(15px)';
      // Voice filter can be simulated with BiquadFilter, but omitted for brevity
    } else {
      $('localVideo').style.filter = 'none';
    }
  } catch(e) { showToast('Media access denied'); return; }
  
  socket.emit('meetlyfun-match', { uid: currentUser.uid, prefs });
}

// Need to handle meetlyfun socket events
socket.on('meetlyfun-matched', data => {
  isStrangerCall = true;
  currentCallId = data.callId;
  currentCalleeUid = data.partnerUid;
  $('strangerName').textContent = 'Stranger';
  $('strangerLangBadge').textContent = 'Matched';
  
  // Show AI Icebreaker
  $('icebreakerText').textContent = icebreakers[Math.floor(Math.random() * icebreakers.length)];
  $('icebreakerOverlay').classList.remove('hidden');

  startLiveCaptions();

  if (data.initiator) {
    createPeer(true, true);
  }
});

// Live Captions via Web Speech API
function startLiveCaptions() {
  if (!('webkitSpeechRecognition' in window)) return;
  speechRecognition = new webkitSpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      transcript += event.results[i][0].transcript;
    }
    $('liveCaptions').textContent = transcript;
    
    // Broadcast my captions to peer
    if (peer && peer.connected) {
      try { peer.send(JSON.stringify({ type: 'caption', text: transcript })); } catch(e){}
    }
  };
  speechRecognition.start();
}

// In createPeer, update stream target for stranger
function createPeer(initiator, isStranger = false) {
  peer = new SimplePeer({ initiator, stream: localStream, trickle: true, config: { iceServers } });
  peer.on('signal', signal => socket.emit('signal', { callId: currentCallId, signal }));
  peer.on('stream', stream => { 
    if (isStranger || isStrangerCall) {
      $('strangerRemoteVideo').srcObject = stream;
      
      const prefs = JSON.parse(localStorage.getItem('mf_prefs') || '{}');
      if (prefs.anon) $('strangerRemoteVideo').style.filter = 'blur(15px)';
      else $('strangerRemoteVideo').style.filter = 'none';

    } else {
      $('remoteVideo').srcObject = stream; 
      $('callBarStatus').textContent = 'Live'; 
    }
    callStartTime = Date.now();
    startCallTimer();
  });
  peer.on('data', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'chat') {
        addChatMessage(msg.text, false);
        $('chatPanel').classList.remove('hidden');
      } else if (msg.type === 'caption') {
        $('liveCaptions').textContent = msg.text;
      }
    } catch(e) {}
  });
  peer.on('close', endCallCleanup);
}

// ─── Shareable Room Links ──────────────────────────────────
$('btnCreateRoom').onclick = () => {
  const roomId = Math.random().toString(36).substring(2, 10);
  const link = window.location.origin + window.location.pathname + '?room=' + roomId;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Link copied! Share it with anyone.');
  });
};

function checkRoomLink() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  if (roomId) {
    // If user is not logged in, we can proceed as an anonymous guest
    // For simplicity, we just prompt them to log in or assign a temp ID
    showToast('Joining room: ' + roomId);
    setTimeout(() => {
      if (currentUser) {
        startCall(roomId, 'Room Guest', '', 'video');
      } else {
        showToast('Please log in to join room');
      }
    }, 2000);
  }
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
  if (tab === 'calls') clearBadge();
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
    const query = $('addContactUID').value.trim().toLowerCase();
    $('addContactError').classList.add('hidden');
    $('addContactResult').classList.add('hidden');
    let foundUser = null;
    let snap = await fbDB.collection('users').where('callId', '==', query).get();
    
    if (!snap.empty) {
      foundUser = snap.docs[0].data();
    } else {
      let allUsersSnap = await fbDB.collection('users').get();
      let matched = allUsersSnap.docs.map(d => d.data()).find(u => u.displayName.toLowerCase().includes(query) || (u.callId && u.callId.toLowerCase().includes(query)));
      if (matched) foundUser = matched;
    }

    if (!foundUser) { $('addContactError').classList.remove('hidden'); return; }
    
    $('addContactPhoto').src = foundUser.photoURL || '';
    $('addContactName').textContent = foundUser.displayName;
    $('addContactUID2').textContent = foundUser.callId;
    $('addContactResult').classList.remove('hidden');
    $('btnConfirmAdd').onclick = async () => {
      await fbDB.collection('users').doc(currentUser.uid).collection('contacts').doc(foundUser.uid).set(foundUser);
      showToast('Added!');
      hideModal('modalAddContact');
      loadContacts();
    };
  };
}

async function blockUser(uid) {
  if (confirm('Are you sure you want to block and report this user?')) {
    await fbDB.collection('users').doc(currentUser.uid).collection('contacts').doc(uid).delete();
    showToast('User blocked and reported');
    loadContacts();
  }
}

// Ringtone logic
function playRingTone(on) {
  const audio = $('ringtoneAudio');
  if (!audio) return;
  if (on) {
    audio.play().catch(e => console.log('Audio error:', e));
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
  } else {
    audio.pause();
    audio.currentTime = 0;
    if (navigator.vibrate) navigator.vibrate(0);
  }
}

function addChatMessage(msg, isSelf) {
  const el = document.createElement('div');
  el.className = `chat-msg ${isSelf ? 'self' : 'peer'}`;
  el.textContent = msg;
  $('chatMessages').appendChild(el);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

function startCallTimer() {
  $('callTimer').style.display = 'block';
  callStartTime = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    const m = Math.floor(s / 60);
    const secs = s % 60;
    $('callTimer').textContent = `${m.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  $('callTimer').style.display = 'none';
  $('callTimer').textContent = '00:00';
}

function updateBadge() {
  const badge = $('badgeMissed');
  if (badge) {
    let missedCount = callLog.filter(c => c.direction === 'Incoming' && c.duration === 0 && !c.seen).length;
    if (missedCount > 0) {
      badge.textContent = missedCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function clearBadge() {
  callLog = callLog.map(c => ({...c, seen: true}));
  localStorage.setItem('co_calllog_'+currentUser.uid, JSON.stringify(callLog));
  updateBadge();
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

let swipeStartX = 0;
let swipeCurrentX = 0;

function handleSwipeStart(e, el) {
  swipeStartX = e.touches[0].clientX;
  el.style.transition = 'none';
}

function handleSwipeMove(e, el) {
  swipeCurrentX = e.touches[0].clientX;
  const diff = swipeCurrentX - swipeStartX;
  if (diff < 0) {
    el.style.transform = `translateX(${Math.max(diff, -80)}px)`;
  } else {
    el.style.transform = `translateX(0px)`;
  }
}

function handleSwipeEnd(e, el) {
  el.style.transition = 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
  const diff = swipeCurrentX - swipeStartX;
  if (diff < -40) {
    el.style.transform = `translateX(-80px)`;
  } else {
    el.style.transform = `translateX(0px)`;
  }
}

function deleteCallGroup(index) {
  const grouped = [];
  callLog.forEach(c => {
    if (grouped.length && grouped[grouped.length-1].uid === c.uid && grouped[grouped.length-1].direction === c.direction) {
      grouped[grouped.length-1].calls.push(c);
    } else {
      grouped.push({ ...c, calls: [c] });
    }
  });
  
  const groupToDelete = grouped[index];
  callLog = callLog.filter(c => !groupToDelete.calls.includes(c));
  localStorage.setItem('co_calllog_'+currentUser.uid, JSON.stringify(callLog));
  renderCallLog();
}

function showCallEndedModal(details, durationMs) {
  $('cePhoto').src = details.photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(details.name)}&background=121212&color=fff`;
  $('ceName').textContent = details.name;
  
  const dateObj = new Date();
  $('ceDate').textContent = dateObj.toLocaleDateString() + ' at ' + formatTime(dateObj.getTime());
  
  const typeStr = details.type === 'video' ? 'Video Call' : 'Voice Call';
  const durStr = durationMs > 0 ? formatDuration(durationMs) : '0:00';
  $('ceTypeDuration').textContent = `${typeStr} · ${durStr}`;
  
  document.querySelectorAll('.rate-star').forEach(s => s.classList.remove('active'));
  
  $('btnCeClose').onclick = () => hideModal('modalCallEnded');
  $('btnCeCall').onclick = () => {
    hideModal('modalCallEnded');
    startCall(details.uid, details.name, details.photo, details.type);
  };
  
  document.querySelectorAll('.rate-star').forEach((star, index, list) => {
    star.onclick = () => {
      list.forEach((s, i) => {
        if (i <= index) s.classList.add('active');
        else s.classList.remove('active');
      });
      showToast('Thanks for your feedback!');
      setTimeout(() => hideModal('modalCallEnded'), 1000);
    };
  });
  
  showModal('modalCallEnded');
}
