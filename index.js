// pombo-relay/index.js
// ============================================
// POMBO RELAY - Push Notification Server
// ============================================
// A simple server that listens to the Streamr network
// and sends push notifications to devices
// ============================================

import 'dotenv/config';
import { StreamrClient } from '@streamr/sdk';
import webpush from 'web-push';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { EventEmitter } from 'events';

// Increase max listeners to prevent memory leak warnings from Streamr SDK
// (Streamr creates many abort listeners internally)
EventEmitter.defaultMaxListeners = 50;
process.setMaxListeners(50);

// ============================================
// CONFIGURATION
// ============================================

const config = {
    relayPrivateKey: process.env.RELAY_PRIVATE_KEY,
    vapid: {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
        email: process.env.VAPID_EMAIL || 'admin@example.com'
    },
    powDifficulty: parseInt(process.env.POW_DIFFICULTY || '4'),
    pushStreamId: process.env.PUSH_STREAM_ID || 'pombo/push/notifications'
};

// ============================================
// CONFIGURATION VALIDATION
// ============================================

function validateConfig() {
    const errors = [];
    
    if (!config.relayPrivateKey || config.relayPrivateKey === '0x...') {
        errors.push('RELAY_PRIVATE_KEY not configured');
    }
    if (!config.vapid.publicKey || config.vapid.publicKey === '...') {
        errors.push('VAPID_PUBLIC_KEY not configured');
    }
    if (!config.vapid.privateKey || config.vapid.privateKey === '...') {
        errors.push('VAPID_PRIVATE_KEY not configured');
    }
    
    if (errors.length > 0) {
        console.error('');
        console.error('❌ CONFIGURATION ERROR:');
        errors.forEach(e => console.error(`   - ${e}`));
        console.error('');
        console.error('💡 Run: npm run generate-keys');
        console.error('   Then copy the keys to the .env file');
        console.error('');
        process.exit(1);
    }
}

validateConfig();

// ============================================
// DATABASE (SQLite)
// ============================================

// Create data/ directory if it does not exist
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'tokens.db'));

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT NOT NULL,
        push_token TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(tag, push_token)
    );
    CREATE INDEX IF NOT EXISTS idx_tag ON registrations(tag);
    
    CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        details TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
`);

console.log('✅ Database initialized');

// ============================================
// WEB PUSH SETUP
// ============================================

webpush.setVapidDetails(
    'mailto:' + config.vapid.email,
    config.vapid.publicKey,
    config.vapid.privateKey
);

console.log('✅ Web Push configured');

// ============================================
// FCM SETUP (native Android clients)
// ============================================
//
// Browsers register a Web Push subscription ({endpoint, keys}); a native
// Android app can only get an FCM registration token. Both register under the
// same tag on the same Streamr stream, so a wake signal fans out to whichever
// transport each device happens to use — the clients never know the difference.
//
// Optional on purpose: without FCM_SERVICE_ACCOUNT the relay keeps serving web
// clients exactly as before and simply rejects native registrations.

let fcmMessaging = null;

async function initFcm() {
    const raw = process.env.FCM_SERVICE_ACCOUNT;
    if (!raw) {
        console.log('ℹ️  FCM not configured (FCM_SERVICE_ACCOUNT unset) — native Android push disabled');
        return;
    }
    try {
        // Accept either a path to the JSON key or the JSON itself, so the key
        // can live in a file or straight in the environment.
        const credentialJson = raw.trim().startsWith('{')
            ? JSON.parse(raw)
            : JSON.parse(fs.readFileSync(path.resolve(raw), 'utf8'));

        // Imported lazily so the relay still starts when the optional
        // dependency is not installed.
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        const app = initializeApp({ credential: cert(credentialJson) });
        fcmMessaging = getMessaging(app);
        console.log(`✅ FCM configured (project: ${credentialJson.project_id})`);
    } catch (e) {
        console.error('❌ FCM setup failed — native Android push disabled:', e.message);
        fcmMessaging = null;
    }
}

await initFcm();

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Validate Proof-of-Work with time-based entropy
 * Accepts PoW from current epoch ±1 to handle clock skew and network latency.
 * Epochs are 10-second windows, so total valid window is ~30 seconds.
 * This prevents replay attacks while being tolerant of timing differences.
 * 
 * @param {string} pow - Hash calculated by the client
 * @param {string} tag - Recipient tag
 * @param {number} nonce - Nonce used
 * @param {number} epoch - 10-second epoch used by the client
 * @returns {boolean}
 */
function validatePoW(pow, tag, nonce, epoch) {
    if (!pow || !tag || nonce === undefined || epoch === undefined) {
        return false;
    }
    
    const target = '0'.repeat(config.powDifficulty);
    const currentEpoch = Math.floor(Date.now() / 10000);
    
    // Accept PoW from current epoch, previous epoch, or next epoch
    // This handles clock skew and network latency (~30 second window)
    const validEpochs = [currentEpoch - 1, currentEpoch, currentEpoch + 1];
    
    // Check if the provided epoch is within acceptable range
    if (!validEpochs.includes(epoch)) {
        console.log(`❌ PoW epoch ${epoch} outside valid range [${validEpochs.join(', ')}]`);
        return false;
    }
    
    try {
        // Validate the hash with the provided epoch
        const data = `${tag}:${epoch}:${nonce}`;
        const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(data));
        return pow === expectedHash && pow.slice(2).startsWith(target);
    } catch (e) {
        console.error('❌ Error validating PoW:', e.message);
        return false;
    }
}

/**
 * Send push notification to a token
 * Implements priority level 10 for both APNS and FCM with advanced headers
 * 
 * APNS Configuration (iOS):
 * - apns-priority: '10' for high-priority alerts (wakes screen immediately)
 * - apns-priority: '5' for background notifications (silent, data-only)
 * - apns-push-type: 'alert' for user-visible notifications
 * - apns-push-type: 'background' for silent background tasks
 * 
 * FCM Configuration (Android):
 * - urgency: 'high' ensures high priority with Google FCM
 * - For Android, prioritization also depends on device state:
 *   * If app is in foreground: Delivered immediately (almost always)
 *   * If app is in background: May be delayed by Doze Mode or Battery Saver
 *   * If device is idle/locked: Can take minutes (system controlled)
 * 
 * Note: Android Doze Mode (introduced in Android 6.0) puts apps to sleep after 10-30 minutes idle,
 * regardless of push priority. This is a system-level restriction, not fixable at the push level.
 * 
 * @param {string} pushTokenJson - JSON of subscription token
 * @param {string} tag - Channel tag (for verification in SW)
 * @param {string} channelType - Channel type ('private' or 'public')
 * @returns {Promise<boolean>}
 */
/**
 * Deliver a wake signal to a native Android client over FCM.
 *
 * Deliberately DATA-ONLY. An FCM `notification` block is drawn by the system
 * before app code runs, which would defeat the whole point of the K-anonymity
 * design: a 1-byte tag collides across many channels, so most pushes are false
 * positives that the client is supposed to discard after checking the storage
 * node. Sending data-only keeps that check — and the decision to show anything
 * at all — in the client, exactly like the service worker does on web.
 *
 * @param {string} token - FCM registration token
 * @param {string} tag - Channel tag (client verifies against it)
 * @param {string} channelType - 'private' or 'public'
 * @returns {Promise<boolean>}
 */
async function sendFcmPush(token, tag, channelType = null) {
    if (!fcmMessaging) {
        console.warn('⚠️  FCM registration present but FCM is not configured');
        return false;
    }
    try {
        await fcmMessaging.send({
            token,
            // Same fields the Web Push payload carries, as strings (FCM data
            // values must be strings).
            data: {
                type: 'wake',
                tag: String(tag),
                channelType: String(channelType || 'unknown'),
                timestamp: String(Date.now())
            },
            android: {
                // Mirrors the Web Push options above: high priority, 24h TTL,
                // and collapse on the tag so a backlog does not arrive as a
                // burst when the device comes back online.
                priority: 'high',
                ttl: 86400 * 1000,
                collapseKey: String(tag)
            }
        });
        return true;
    } catch (e) {
        // A token stops being valid when the app is reinstalled or its data is
        // cleared; drop it so we do not keep paying for dead rows.
        const code = e.errorInfo?.code || e.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            try {
                db.prepare('DELETE FROM registrations WHERE push_token = ?')
                    .run(JSON.stringify({ fcmToken: token }));
                console.log('🗑️  Removed stale FCM token');
                logEvent('fcm_token_removed', code);
            } catch (dbErr) {
                console.error('❌ Failed to remove stale FCM token:', dbErr.message);
            }
            return false;
        }
        console.error('❌ FCM send failed:', e.message);
        logEvent('fcm_send_error', e.message);
        return false;
    }
}

async function sendPush(pushTokenJson, tag, channelType = null) {
    try {
        const subscription = JSON.parse(pushTokenJson);

        // Native Android client — send over FCM instead of Web Push.
        if (subscription.fcmToken) {
            return await sendFcmPush(subscription.fcmToken, tag, channelType);
        }

        // Detect if this is an Android device (FCM token pattern)
        const isAndroid = subscription.endpoint && subscription.endpoint.includes('fcm.googleapis.com');

        const payload = JSON.stringify({ 
            type: 'wake',
            tag: tag,
            channelType: channelType || 'unknown',
            timestamp: Date.now()
        });

        // Advanced Web Push options for maximum priority and reliability
        const options = {
            // Time-To-Live in seconds
            // If device is offline, the push service will retry for this duration
            TTL: 86400, // 24 hours - ensures delivery even if device is offline

            // Urgency for Web Push Protocol (supported by FCM)
            // Options: 'very-low', 'low', 'normal', 'high'
            // For Android: 'high' triggers HIGH_PRIORITY in FCM
            urgency: 'high',

            // Topic/Collapse Key
            // If multiple notifications with same topic are sent while device is offline,
            // only the latest one is delivered when device comes online
            // Reduces battery drain and prevents notification spam
            topic: tag,

            // Native headers for APNS (Apple Push Notification service)
            headers: {
                // APNS Priority:
                // '10' = High priority (immediate, wakes screen, plays sound/vibration)
                //        REQUIRED for user-visible notifications with alert
                // '5'  = Low priority (background, silent, may be delayed)
                //        ONLY use with 'background' push-type
                'apns-priority': '10',

                // APNS Push Type:
                // 'alert'      = User-visible notification (title + body)
                // 'background' = Silent notification (data-only, wakes app in background)
                // 'voip'       = VoIP push
                // 'complication' = Apple Watch complication
                // Must match priority: alert needs priority 10, background needs priority 5
                'apns-push-type': 'alert',

                // (Optional) APNS expiration time as UNIX epoch seconds
                // Sets when this notification expires on Apple servers
                // If not set, defaults to TTL
                'apns-expiration': Math.floor(Date.now() / 1000) + 86400
            }
        };
        
        // Add FCM-specific headers for Android devices
        // These improve delivery speed on Android but may not override Doze Mode
        if (isAndroid) {
            options.headers['X-Goog-Firebase-Analytic-Origin'] = 'pombo-relay';
        }
                 
        await webpush.sendNotification(subscription, payload, options);
        
        if (isAndroid) {
            console.log('📱 Android notification sent (may be delayed by Doze Mode)');
        } else {
            console.log('🍎 iOS notification sent');
        }
        
        return true;
        
    } catch (error) {
        // Specific error codes
        if (error.statusCode === 410 || error.statusCode === 404) {
            // Token expired or invalid - remove from DB
            db.prepare('DELETE FROM registrations WHERE push_token = ?').run(pushTokenJson);
            console.log('🗑️  Expired token removed');
            logEvent('token_expired', pushTokenJson.slice(0, 50));
        } else if (error.statusCode === 429) {
            console.warn('⚠️  Rate limited by FCM/APNS');
            logEvent('rate_limited', error.message);
        } else {
            console.error('❌ Push failed:', error.statusCode || error.message);
            logEvent('push_error', error.message);
        }
        return false;
    }
}

/**
 * Log event for statistics
 */
function logEvent(event, details = null) {
    try {
        db.prepare('INSERT INTO stats (event, details) VALUES (?, ?)').run(event, details);
    } catch (e) {
        // Ignore logging errors
    }
}

/**
 * Get statistics
 */
function getStats() {
    const registrations = db.prepare('SELECT COUNT(*) as count FROM registrations').get();
    const pushesToday = db.prepare(`
        SELECT COUNT(*) as count FROM stats 
        WHERE event = 'push_sent' 
        AND created_at > strftime('%s', 'now', '-1 day')
    `).get();
    
    return {
        registrations: registrations.count,
        pushesToday: pushesToday.count
    };
}

// ============================================
// STREAMR CLIENT
// ============================================

console.log('🔄 Connecting to Streamr...');

let client;
let relayAddress;

try {
    client = new StreamrClient({
        auth: { privateKey: config.relayPrivateKey },
        // Telemetry OFF (SDK default is on when auth.ethereum is undefined). The relay
        // address is already public, so this is not a privacy fix here — it just stops a
        // pointless publish to streamr.eth/metrics/nodes/firehose/* every 60s.
        metrics: false,
        // Pinned Polygon RPCs (same list as the web client). The SDK defaults
        // have shipped dead endpoints before (polygon-rpc.com, sunset 2025-07-31),
        // so the relay never relies on them.
        contracts: {
            rpcs: [
                { url: 'https://polygon.drpc.org' },
                { url: 'https://polygon-bor-rpc.publicnode.com' },
                { url: 'https://rpc.ankr.com/polygon' }
            ],
            rpcQuorum: 1
        },
        // Network configuration
        network: {
            // Use SDK defaults
        }
    });
    
    relayAddress = await client.getAddress();
    console.log(`✅ Connected to Streamr`);
    console.log(`📍 Relay Address: ${relayAddress}`);
} catch (error) {
    console.error('❌ Failed to connect to Streamr:', error.message);
    process.exit(1);
}

// ============================================
// SINGLE STREAM (pre-created)
// ============================================
// The stream has been created externally.
// We use the same stream for registrations AND notifications,
// differentiating by the 'type' field of the message.

/**
 * Handle new device registration
 */
function handleRegistration(payload) {
    try {
        // Validate required fields
        if (!payload) {
            console.log('⚠️  Invalid registration - null payload');
            logEvent('registration_error', 'null_payload');
            return;
        }
        
        if (!payload.tag) {
            console.log('⚠️  Invalid registration - missing tag');
            logEvent('registration_error', 'missing_tag');
            return;
        }
        
        if (!payload.subscription) {
            console.log('⚠️  Invalid registration - missing subscription');
            logEvent('registration_error', 'missing_subscription');
            return;
        }
        
        const { tag, subscription } = payload;
        const pushToken = typeof subscription === 'string' 
            ? subscription 
            : JSON.stringify(subscription);
        
        // Validate token format. Two shapes are accepted: a Web Push
        // subscription ({endpoint, keys}) from a browser, or {fcmToken} from a
        // native Android client. Both are stored as opaque strings under the
        // same tag; sendPush picks the transport back out.
        try {
            const parsed = JSON.parse(pushToken);
            if (!parsed.endpoint && !parsed.fcmToken) {
                console.log('⚠️  Invalid token - no endpoint and no fcmToken');
                logEvent('registration_error', 'no_endpoint');
                return;
            }
            if (parsed.fcmToken && !fcmMessaging) {
                // Accept and store it anyway: FCM may be configured later and
                // the client should not have to re-register.
                console.log('⚠️  FCM registration stored but FCM is not configured yet');
                logEvent('registration_warning', 'fcm_not_configured');
            }
        } catch (e) {
            console.log('⚠️  Invalid token - not valid JSON');
            logEvent('registration_error', 'invalid_json');
            return;
        }
        
        // Save to DB
        try {
            const stmt = db.prepare(`
                INSERT INTO registrations (tag, push_token, updated_at) 
                VALUES (?, ?, strftime('%s', 'now'))
                ON CONFLICT(tag, push_token) DO UPDATE SET updated_at = strftime('%s', 'now')
            `);
            stmt.run(tag, pushToken);
            
            console.log(`✅ Registration: tag=${tag.slice(0, 10)}...`);
            logEvent('registration', tag);
        } catch (dbErr) {
            console.error('❌ Database error:', dbErr.message);
            logEvent('db_error', dbErr.message);
        }
        
    } catch (e) {
        console.error('❌ Error processing registration:', e.message);
        logEvent('registration_error', e.message);
    }
}

// ============================================
// STREAM SUBSCRIPTION (pre-created)
// ============================================

console.log(`🔄 Subscribing to stream: ${config.pushStreamId}`);

// Listen for messages (registrations and notifications on same stream)
try {
    await client.subscribe(config.pushStreamId, async (content, metadata) => {
        try {
            lastMessageTime = Date.now(); // Update health check timestamp
            
            // Log all messages for debugging
            if (!content.type) {
                console.log('📨 Message received (no type):', JSON.stringify(content).slice(0, 100));
            }
            
            // Identify message type by 'type' field
            if (content.type === 'registration') {
                handleRegistration(content);
            } else if (content.type === 'notification' || content.tag) {
                // If no type but has tag, it's a notification
                await handleNotification(content);
            } else {
                console.log('⚠️  Unknown message type:', content.type);
            }
        } catch (err) {
            console.error('❌ Error in message handler:', err.message);
            logEvent('handler_error', err.message);
        }
    });
    console.log(`📥 Listening on: ${config.pushStreamId}`);
} catch (error) {
    console.error('❌ Failed to subscribe to stream:', error.message);
    process.exit(1);
}

/**
 * Handle notification (wake signal)
 */
async function handleNotification(payload) {
    try {
        // Validate fields
        if (!payload || !payload.tag || !payload.pow || payload.nonce === undefined || payload.epoch === undefined) {
            console.log('⚠️  Invalid notification - missing fields');
            return;
        }
        
        const { tag, pow, nonce, epoch, channelType } = payload;
        
        console.log(`🔍 Wake signal received: tag=${tag}, epoch=${epoch}, channelType=${channelType || 'unknown'}`);
        
        // Validate PoW
        if (!validatePoW(pow, tag, nonce, epoch)) {
            console.log(`⚠️  Invalid PoW for tag ${tag}`);
            logEvent('invalid_pow', tag);
            return;
        }
        
        // Find tokens with this tag
        const tokens = db.prepare(
            'SELECT push_token FROM registrations WHERE tag = ?'
        ).all(tag);
        
        if (tokens.length === 0) {
            console.log(`❌ No tokens found for tag ${tag}`);
            return;
        }
        
        console.log(`📤 Wake signal for ${tokens.length} device(s) (tag: ${tag})`);
        
        // Send push to each token
        let sent = 0;
        let failed = 0;
        
        for (const { push_token } of tokens) {
            if (await sendPush(push_token, tag, channelType)) {
                sent++;
            } else {
                failed++;
            }
        }
        
        console.log(`✅ Result: ${sent} sent, ${failed} failed`);
        logEvent('push_sent', JSON.stringify({ tag, sent, failed }));
        
    } catch (e) {
        console.error('❌ Error processing notification:', e.message);
        logEvent('notification_error', e.message);
    }
}

// ============================================
// STATISTICS (every 60 seconds)
// ============================================

setInterval(() => {
    const stats = getStats();
    console.log(`📊 Stats: ${stats.registrations} devices, ${stats.pushesToday} pushes (24h)`);
}, 60000);

// Health check - verify relay is still connected (every 5 minutes)
// Just informational, not alarming - low traffic is normal
let lastMessageTime = Date.now();

setInterval(() => {
    const now = Date.now();
    const timeSinceLastMessage = Math.round((now - lastMessageTime) / 1000);
    const minutes = Math.round(timeSinceLastMessage / 60);
    
    // Only warn if no messages for 30+ minutes - that might indicate a real problem
    if (timeSinceLastMessage > 1800000) {
        console.warn(`⚠️  No messages for 30+ minutes (${minutes} min) - check if relay is still receiving data`);
        logEvent('health_check_warning', `no_messages_${minutes}min`);
    } else {
        console.log(`ℹ️  Health: Connection active, last message ${minutes} min ago`);
    }
}, 300000); // Check every 5 minutes

// ============================================
// ADMIN HTTP API (optional, on port ADMIN_PORT)
// ============================================

const ADMIN_PORT = process.env.ADMIN_PORT ? parseInt(process.env.ADMIN_PORT) : 8000;

// Skip admin API if port is 0
if (ADMIN_PORT === 0) {
    console.log('ℹ️  Admin API disabled (ADMIN_PORT=0)');
} else {
    function sendJSON(res, statusCode, data) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    }

    function sendError(res, statusCode, message) {
        sendJSON(res, statusCode, { error: message });
    }

    const adminServer = http.createServer((req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const searchParams = url.searchParams;
        
        // GET /admin/stats
        if (pathname === '/admin/stats' && req.method === 'GET') {
            const registrations = db.prepare('SELECT COUNT(*) as count FROM registrations').get();
            const pushesToday = db.prepare(`
                SELECT COUNT(*) as count FROM stats 
                WHERE event = 'push_sent' 
                AND created_at > strftime('%s', 'now', '-1 day')
            `).get();
            
            const tagStats = db.prepare(`
                SELECT tag, COUNT(*) as count FROM registrations
                GROUP BY tag
                ORDER BY count DESC
            `).all();
            
            return sendJSON(res, 200, {
                registrations: registrations.count,
                pushesToday: pushesToday.count,
                byTag: tagStats,
                relayAddress,
                stream: config.pushStreamId
            });
        }
        
        // GET /admin/registrations?tag=pombo/chat
        if (pathname === '/admin/registrations' && req.method === 'GET') {
            const tag = searchParams.get('tag');
            let registrations;
            
            if (tag) {
                registrations = db.prepare(
                    'SELECT id, tag, push_token, created_at, updated_at FROM registrations WHERE tag = ? ORDER BY created_at DESC'
                ).all(tag);
            } else {
                registrations = db.prepare(
                    'SELECT id, tag, push_token, created_at, updated_at FROM registrations ORDER BY tag, created_at DESC'
                ).all();
            }
            
            return sendJSON(res, 200, {
                count: registrations.length,
                tag: tag || 'all',
                registrations: registrations.map(r => ({
                    id: r.id,
                    tag: r.tag,
                    token: r.push_token.slice(0, 80) + (r.push_token.length > 80 ? '...' : ''),
                    created: new Date(r.created_at * 1000).toISOString(),
                    updated: new Date(r.updated_at * 1000).toISOString()
                }))
            });
        }
        
        // GET /admin/events?limit=50
        if (pathname === '/admin/events' && req.method === 'GET') {
            const limit = parseInt(searchParams.get('limit')) || 50;
            const events = db.prepare(`
                SELECT event, details, created_at FROM stats
                ORDER BY created_at DESC
                LIMIT ?
            `).all(limit);
            
            return sendJSON(res, 200, {
                count: events.length,
                events: events.map(e => ({
                    event: e.event,
                    details: e.details,
                    time: new Date(e.created_at * 1000).toISOString()
                }))
            });
        }
        
        // DELETE /admin/registrations/<tag>
        if (pathname.startsWith('/admin/registrations/') && req.method === 'DELETE') {
            const tag = pathname.replace('/admin/registrations/', '').split('?')[0];
            
            if (!tag) {
                return sendError(res, 400, 'Tag required');
            }
            
            const count = db.prepare('SELECT COUNT(*) as count FROM registrations WHERE tag = ?').get(tag);
            
            if (count.count === 0) {
                return sendError(res, 404, `No registrations found for tag: ${tag}`);
            }
            
            db.prepare('DELETE FROM registrations WHERE tag = ?').run(tag);
            
            return sendJSON(res, 200, {
                message: `Deleted ${count.count} device${count.count !== 1 ? 's' : ''} for tag: ${tag}`,
                deleted: count.count
            });
        }
        
        // GET /admin/help or /admin
        if ((pathname === '/admin' || pathname === '/admin/help') && req.method === 'GET') {
            return sendJSON(res, 200, {
                name: 'Pombo Relay Admin API',
                version: '1.0.0',
                endpoints: {
                    'GET /admin/stats': 'Overall statistics and breakdown',
                    'GET /admin/registrations': 'List all registrations (add ?tag=xyz to filter)',
                    'GET /admin/events': 'Recent events (add ?limit=100 to change)',
                    'DELETE /admin/registrations/<tag>': 'Delete all registrations for a tag',
                    'GET /admin/help': 'This help message'
                },
                examples: {
                    stats: `curl http://localhost:${ADMIN_PORT}/admin/stats`,
                    listAll: `curl http://localhost:${ADMIN_PORT}/admin/registrations`,
                    listTag: `curl "http://localhost:${ADMIN_PORT}/admin/registrations?tag=pombo/chat"`,
                    events: `curl "http://localhost:${ADMIN_PORT}/admin/events?limit=100"`,
                    delete: `curl -X DELETE http://localhost:${ADMIN_PORT}/admin/registrations/pombo/chat`
                }
            });
        }
        
        // 404
        sendError(res, 404, 'Endpoint not found. Try /admin/help');
    });

    adminServer.listen(ADMIN_PORT, () => {
        console.log(`✅ Admin API listening on port ${ADMIN_PORT}`);
        console.log(`   Documentation: http://localhost:${ADMIN_PORT}/admin/help`);
    });

    // Store reference for shutdown
    global.adminServer = adminServer;
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    
    try {
        if (client) {
            await client.destroy();
        }
    } catch (e) {
        // Ignore shutdown errors
    }
    
    try {
        db.close();
    } catch (e) {
        // Ignore shutdown errors
    }
    
    try {
        if (global.adminServer) {
            await new Promise((resolve) => {
                global.adminServer.close(resolve);
            });
        }
    } catch (e) {
        // Ignore shutdown errors
    }
    
    console.log('👋 Relay shutdown complete');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    logEvent('uncaught_exception', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
    logEvent('unhandled_rejection', String(reason));
});

// ============================================
// STARTUP BANNER
// ============================================

const stats = getStats();

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  🕊️  POMBO RELAY ONLINE');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Address:       ${relayAddress}`);
console.log(`  Stream:        ${config.pushStreamId}`);
console.log(`  PoW:           ${config.powDifficulty} zeros`);
console.log(`  Devices:       ${stats.registrations}`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('📋 For clients to use this relay:');
console.log(`   Relay Address: ${relayAddress}`);
console.log(`   VAPID Key:     ${config.vapid.publicKey}`);
console.log('');
console.log('⏳ Listening for messages... (Ctrl+C to exit)');
console.log('');
