// ════════════════════════════════════════════════════════════
//  FIREBASE CONFIG  — Replace these values with your own project
//  https://console.firebase.google.com → Project Settings → SDK
// ════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyDCYElfAwrIYAGK1qWf6crxwL6-AEbGjFc",
  authDomain: "callit-o.firebaseapp.com",
  projectId: "callit-o",
  storageBucket: "callit-o.firebasestorage.app",
  messagingSenderId: "258193712779",
  appId: "1:258193712779:web:c03b5046a85ac5cfafd68e"
};

firebase.initializeApp(firebaseConfig);

window.fbAuth = firebase.auth();
window.fbDB   = firebase.firestore();

// Google Auth Provider
window.googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
