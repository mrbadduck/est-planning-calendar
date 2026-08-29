// Firebase auth for the EST apps. Buildless: modular SDK straight from the CDN.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onIdTokenChanged, signOut as fbSignOut,
  GoogleAuthProvider, signInWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// Public config (safe to commit) — from Firebase console.
const firebaseConfig = {
  apiKey: 'AIzaSyDPxvSqK7Rnj6x2W7Nemo5pR4ymZPWJOqY',   // public by design (Firebase web key)
  authDomain: 'est-planning-calendar.firebaseapp.com',
  projectId: 'est-planning-calendar',
  appId: '1:463482291986:web:a3a220412fbc7ff78c55cb',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const EMAIL_KEY = 'est-emailForSignIn';

window.estAuth = {
  // app.js calls this once with callbacks; we stream ID tokens as they change.
  // ID tokens expire after 1h and the SDK does NOT refresh them in the
  // background — apps cache the raw string, so without the proactive refresh
  // below a long-open tab starts getting 401 "invalid token" from the Worker.
  init({ onToken, onSignedOut }) {
    onIdTokenChanged(auth, async (user) => {
      if (user) onToken(await user.getIdToken());
      else onSignedOut();
    });
    // Force-refresh well before the 1h expiry; onIdTokenChanged streams the new
    // token to the app. And on returning to the tab (wake/refocus — timers may
    // not have fired), refresh lazily: getIdToken() re-mints only if expired.
    setInterval(() => { if (auth.currentUser) auth.currentUser.getIdToken(true).catch(() => {}); }, 45 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && auth.currentUser) auth.currentUser.getIdToken().catch(() => {});
    });
  },
  async signInWithGoogle() {
    await signInWithPopup(auth, new GoogleAuthProvider());
  },
  async sendEmailLink(email) {
    const url = window.location.origin + window.location.pathname;   // return here, no query
    await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
    try { localStorage.setItem(EMAIL_KEY, email); } catch (_) {}
  },
  // Call on load: if the URL is a sign-in link, complete it. Returns true if it did.
  async completeEmailLinkIfPresent() {
    if (!isSignInWithEmailLink(auth, window.location.href)) return false;
    let email = '';
    try { email = localStorage.getItem(EMAIL_KEY) || ''; } catch (_) {}
    if (!email) email = window.prompt('Confirm your email to finish signing in') || '';
    if (!email) return false;
    await signInWithEmailLink(auth, email, window.location.href);
    try { localStorage.removeItem(EMAIL_KEY); } catch (_) {}
    // strip the sign-in params from the URL so a refresh doesn't re-trigger.
    history.replaceState(null, '', window.location.origin + window.location.pathname);
    return true;
  },
  async signOut() { await fbSignOut(auth); },
};

// Let app.js know the bridge is ready (it may have loaded first — classic script).
window.dispatchEvent(new Event('estauth:ready'));
