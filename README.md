# DirectCall 📞📹

A WhatsApp-style direct **video & voice call** app — completely separate from MeetlyFUN.

## Features
- 🔑 **Google Sign-In** — every user gets a unique UID automatically
- 👥 **Add Contacts** by UID — search any user and add to your list
- 📹 **Video Calls** — full-screen WebRTC, HD
- 📞 **Voice Calls** — audio-only mode
- 🟢 **Online status** — see who's available
- 🔄 **Camera flip** — front/back toggle
- 🔇 **Mute / Camera off** controls
- 📋 **Call History** — log of all recent calls

## Tech Stack
- Node.js + Express + Socket.IO (signaling server)
- WebRTC via SimplePeer
- Firebase Auth (Google Login) + Firestore (user data, contacts)

---

## ⚡ Quick Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set up Firebase
1. Go to https://console.firebase.google.com
2. Create a new project
3. Enable **Authentication → Google** sign-in method
4. Enable **Firestore Database**
5. Go to **Project Settings → SDK** → copy config
6. Paste config into `public/firebase-config.js`

### 3. Firestore Security Rules
Go to Firestore → Rules and paste:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
      match /contacts/{contactId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
}
```

### 4. Run
```bash
npm start
# or for development with auto-reload:
npm run dev
```

Open http://localhost:3001

---

## Folder Structure
```
DirectCall/
├── server.js          ← Signaling server (Socket.IO)
├── package.json
└── public/
    ├── index.html     ← Full app UI
    ├── style.css      ← Dark WhatsApp-style design
    ├── app.js         ← Auth, contacts, WebRTC, call logic
    ├── firebase-config.js  ← YOUR Firebase config goes here
    └── favicon.svg
```

---

## How Calling Works
1. User A searches User B's UID → adds as contact
2. User A taps the call button → chooses Voice or Video
3. Server (Socket.IO) rings User B
4. User B accepts → WebRTC peer connection established
5. Full-screen HD call — both users see each other
