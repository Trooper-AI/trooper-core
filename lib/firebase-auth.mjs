import admin from 'firebase-admin';

let firebaseApp = null;

/**
 * Initialize Firebase Admin. Supports:
 * 1. GOOGLE_APPLICATION_CREDENTIALS env var (service account JSON path)
 * 2. FIREBASE_SERVICE_ACCOUNT env var (JSON string)
 * 3. FIREBASE_PROJECT_ID env var (for default credentials / GCE)
 */
export function initFirebaseAuth() {
  if (firebaseApp) return;

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      firebaseApp = admin.initializeApp();
    } else if (process.env.FIREBASE_PROJECT_ID) {
      firebaseApp = admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    } else {
      console.warn('[firebase-auth] No Firebase credentials configured — auth disabled');
      return;
    }
    console.log('[firebase-auth] Initialized');
  } catch (err) {
    // Already initialized (e.g., from another module)
    if (err.code === 'app/duplicate-app') {
      firebaseApp = admin.app();
    } else {
      console.error('[firebase-auth] Init failed:', err.message);
    }
  }
}

/**
 * Verify a Firebase ID token.
 * Returns decoded token { uid, email, name, ... } or null on failure.
 */
export async function verifyIdToken(token) {
  if (!firebaseApp) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || decoded.email?.split('@')[0] || null,
      picture: decoded.picture || null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Check if Firebase Auth is available.
 */
export function isAuthEnabled() {
  return !!firebaseApp;
}

/**
 * Express middleware: verify Firebase ID token from Authorization header.
 * Used for direct frontend → bridge REST calls (Phase 2 self-hosted).
 *
 * Auth logic (OR — any one is sufficient):
 * 1. Valid Firebase ID token in Authorization: Bearer <token>
 * 2. Valid bridge auth token (BRIDGE_AUTH_TOKEN) — for server-to-server calls
 * 3. Valid API key in X-API-Key header — for Obsidian plugin etc.
 * 4. No auth configured at all (dev mode) — pass through
 *
 * On success, sets req.firebaseUser = { uid, email, name, picture }
 */
export function firebaseRestAuth(bridgeAuthToken, apiKeysGetter) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const apiKey = req.headers['x-api-key'] || '';

    // 1. Bridge auth token (server-to-server) — always accepted
    if (bridgeAuthToken && token === bridgeAuthToken) {
      return next();
    }

    // 2. API key (Obsidian, external integrations)
    if (apiKey && typeof apiKeysGetter === 'function') {
      const keys = apiKeysGetter();
      if (Array.isArray(keys) && keys.some(k => k.key === apiKey)) {
        return next();
      }
    }

    // 3. Firebase ID token
    if (token && firebaseApp) {
      const user = await verifyIdToken(token);
      if (user) {
        req.firebaseUser = user;
        return next();
      }
    }

    // 4. No auth configured — dev/single-tenant mode
    if (!firebaseApp && !bridgeAuthToken) {
      return next();
    }

    // 5. No valid auth found
    res.status(401).json({ error: 'Authentication required. Provide a Firebase ID token, bridge auth token, or API key.' });
  };
}
