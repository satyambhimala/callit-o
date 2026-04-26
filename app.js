/* ══════════════════════════════════════════════════════════
   Callit-o — Premium App Logic
══════════════════════════════════════════════════════════ */

let currentUser = null;
let socket = null;
let peer = null;
let localStream = null;
let currentCallId = null;
let currentCalleeUid = null;
let callStartTime = null;
let timerInterval = null;
let facingMode = 'user';
let contacts = [];
let callLog = [];

// ─── DOM HELPERS ──────────────────────────────────────────
const $ = s => document.querySelector(s);
const showScreen = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};
const showModal = id => $(id).classList.add('active');
const hideModal = id => $(id).classList.remove('active');
const showToast = m => {
  const t = $('#toast');
  t.textContent = m;
  t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 3000);
};

// ─── INIT ──────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupAuth();
  setupTabSystem();
  setupCallHandlers();
  setupExplore();
});

// ─── AUTH ──────────────────────────────────────────────────
function setupAuth() {
  fbAuth.onAuthStateChanged(async user => {
    $('#splashScreen').classList.remove('active');
    if (user) {
      currentUser = user;
      await ensureUserDoc(user);
      connectSocket();
      renderProfile();
      loadContacts();
      loadCallLog();
      showScreen('#appScreen');
    } else {
      showScreen('#authScreen');
    }
  });

  $('#btnGoogleLogin').onclick = () => fbAuth.signInWithPopup(googleProvider);
  $('#btnSignOut').onclick = () => fbAuth.signOut();
}

async function ensureUserDoc(user) {
  const ref = fbDB.collection('users').doc(user.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const callId = user.displayName.toLowerCase().replace(/\s/g, '') + Math.floor(Math.random() * 100);
    await ref.set({
      uid: user.uid,
      displayName: user.displayName,
      photoURL: user.photoURL,
      callId: callId,
      status: 'Available'
    });
  }
}

// ─── NAVIGATION & TABS ─────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab${btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1)}`).classList.add('active');
      $('#headerTitle').textContent = btn.dataset.tab === 'recent' ? 'Recent' : btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1);
    };
  });
}

function setupTabSystem() {
  $('#btnConfirmAdd').onclick = async () => {
    const id = $('#addContactID').value.trim();
    if (!id) return;
    const snap = await fbDB.collection('users').where('callId', '==', id).get();
    if (snap.empty) return showToast('User not found');
    const friend = snap.docs[0].data();
    await fbDB.collection('users').doc(currentUser.uid).collection('contacts').doc(friend.uid).set(friend);
    showToast('Contact Added');
    hideModal('#modalAddContact');
    loadContacts();
  };
}

// ─── SOCKET & REALTIME ─────────────────────────────────────
function connectSocket() {
  socket = io('https://callit-o-server.onrender.com');
  socket.on('connect', () => socket.emit('user-online', { uid: currentUser.uid }));
  socket.on('incoming-call', handleIncomingCall);
  socket.on('call-accepted', handleCallAccepted);
  socket.on('call-rejected', handleCallRejected);
  socket.on('call-ended', handleCallEnded);
  socket.on('signal', data => peer && peer.signal(data.signal));
}

// ─── CALL LOGIC ────────────────────────────────────────────
async function startCall(targetUid, type = 'video') {
  currentCalleeUid = targetUid;
  const snap = await fbDB.collection('users').doc(targetUid).get();
  const target = snap.data();
  
  $('#callPeerName').textContent = target.displayName;
  $('#callStatus').textContent = 'Calling...';
  showScreen('#callScreen');

  localStream = await navigator.mediaDevices.getUserMedia({ video: type === 'video', audio: true });
  $('#localVideo').srcObject = localStream;

  socket.emit('start-call', {
    to: targetUid,
    from: currentUser.uid,
    fromName: currentUser.displayName,
    fromPhoto: currentUser.photoURL,
    type
  });
}

function handleIncomingCall(data) {
  currentCallId = data.callId;
  $('#incomingName').textContent = data.fromName;
  $('#incomingPhoto').src = data.fromPhoto;
  $('#ringtone').play();
  showScreen('#incomingScreen');
}

$('#btnAccept').onclick = async () => {
  $('#ringtone').pause();
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  $('#localVideo').srcObject = localStream;
  socket.emit('accept-call', { callId: currentCallId });
  showScreen('#callScreen');
};

$('#btnReject').onclick = () => {
  $('#ringtone').pause();
  socket.emit('reject-call', { callId: currentCallId });
  showScreen('#appScreen');
};

function handleCallAccepted() {
  $('#callStatus').textContent = 'Connected';
  startPeer(true);
}

function handleCallRejected() {
  showToast('Call Rejected');
  showScreen('#appScreen');
}

function startPeer(initiator) {
  peer = new SimplePeer({ initiator, stream: localStream, trickle: false });
  peer.on('signal', signal => socket.emit('signal', { callId: currentCallId, signal }));
  peer.on('stream', stream => {
    $('#remoteVideo').srcObject = stream;
    startTimer();
  });
  peer.on('close', endCall);
}

function startTimer() {
  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    $('#callTimer').textContent = new Date(s * 1000).toISOString().substr(14, 5);
  }, 1000);
}

function endCall() {
  clearInterval(timerInterval);
  if (peer) peer.destroy();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  peer = null;
  localStream = null;
  showScreen('#appScreen');
}

$('#btnHangup').onclick = () => {
  socket.emit('end-call', { callId: currentCallId });
  endCall();
};

function handleCallEnded() {
  showToast('Call Ended');
  endCall();
}

// ─── EXPLORE (MEETLYFUN) ───────────────────────────────────
function setupExplore() {
  $('#btnStartExplore').onclick = async () => {
    $('#exploreWaiting').classList.add('hidden');
    $('#exploreActive').classList.remove('active'); // toggle logic
    // Add MeetlyFUN logic here
  };
}

// ─── DATA LOADING ──────────────────────────────────────────
async function loadContacts() {
  const snap = await fbDB.collection('users').doc(currentUser.uid).collection('contacts').get();
  const list = $('#contactsList');
  list.innerHTML = '';
  snap.forEach(doc => {
    const u = doc.data();
    const el = document.createElement('div');
    el.className = 'item-row';
    el.innerHTML = `
      <img src="${u.photoURL}" class="avatar">
      <div class="item-info">
        <div class="item-name">${u.displayName}</div>
        <div class="item-meta">${u.status || 'Available'}</div>
      </div>
      <button class="btn-circle" onclick="startCall('${u.uid}')"><svg style="width:20px;height:20px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></button>
    `;
    list.appendChild(el);
  });
}

function renderProfile() {
  $('#profileAvatar').src = currentUser.photoURL;
  $('#profileName').textContent = currentUser.displayName;
  fbDB.collection('users').doc(currentUser.uid).get().then(snap => {
    $('#profileUID').textContent = `ID: ${snap.data().callId}`;
  });
}

function loadCallLog() {
  // Simple call log logic
}
