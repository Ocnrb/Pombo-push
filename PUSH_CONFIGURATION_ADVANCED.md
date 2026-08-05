# Pombo Relay - Advanced Push Notification Configuration

## Overview

The Pombo Relay sends **priority level 10 for all messages** across both Apple APNS and Google FCM, ensuring maximum delivery speed and reliability. Native Android clients are served over data-only FCM messages via `firebase-admin` (see section 8).

---

## 1. Priority Levels & Headers

### APNS (Apple Push Notification Service)

| Header | Value | Use Case | Effect |
|--------|-------|----------|--------|
| `apns-priority` | `10` | **High-priority user-visible alerts** | Wakes screen immediately, plays sound, vibrates |
| `apns-priority` | `5` | Silent background notifications | May be delayed, no user alert |
| `apns-push-type` | `alert` | User-visible notification | Must use priority `10` |
| `apns-push-type` | `background` | Data-only, silent wake-up | Must use priority `5` |
| `apns-expiration` | UNIX timestamp | When notification expires on Apple servers | Prevent stale notifications |

### Current Configuration (sendPush function)

```javascript
headers: {
    'apns-priority': '10',           // Maximum priority
    'apns-push-type': 'alert',       // User-visible notification
    'apns-expiration': Math.floor(Date.now() / 1000) + 86400  // Expires in 24 hours
}
```

**⚠️ CRITICAL APPLE RULE:**
- If notification is **visible** (has title/body) → priority MUST be `10` + push-type `alert`
- If notification is **silent** (data-only background wake) → priority MUST be `5` + push-type `background`
- Using `10` with `background` type = **Apple blocks delivery**

### FCM (Firebase Cloud Messaging - Google)

| Field | Value | Effect |
|-------|-------|--------|
| `urgency` | `high` | High priority delivery, wakes apps immediately |
| `urgency` | `normal` | Normal priority (default) |

**Current Configuration:**
```javascript
urgency: 'high'  // Google FCM high-priority mode
```

---

## 2. Additional Web Push Configuration Options

### TTL (Time-To-Live)

```javascript
TTL: 86400  // 24 hours in seconds
```

**Behavior:**
- If device is offline, the push service retries for this duration
- After TTL expires, notification is discarded if not delivered
- Current: 24 hours ensures delivery even if device is offline for extended periods

**Recommendations:**
- `60` - For time-sensitive alerts (expires in 1 minute)
- `3600` - For important messages (expires in 1 hour)
- `86400` - For all notifications (expires in 24 hours) - **Current setting**

### Topic (Collapse Key)

```javascript
topic: tag  // Collapse key = channel tag
```

**Behavior:**
- If multiple notifications with same `topic` are queued while device offline
- Only the **latest one** is delivered when device comes online
- Reduces battery drain and prevents notification spam

**Benefits:**
- No duplicate notifications on reconnect
- Saves bandwidth and battery
- Automatically handles network reconnection scenarios

---

## 3. Payload Structure

```json
{
    "type": "wake",
    "tag": "channel-name",
    "channelType": "private",
    "timestamp": 1234567890000
}
```

| Field | Purpose |
|-------|---------|
| `type` | Message type identifier (wake signal) |
| `tag` | Channel tag for Service Worker verification |
| `channelType` | Permission scope ('private', 'public', etc.) |
| `timestamp` | UNIX milliseconds for ordering/replay detection |

---

## 4. Error Handling

### HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| `200` | Success | Notification delivered to push service |
| `410` | Gone | Token expired/unregistered - **removed from DB** |
| `404` | Not Found | Invalid token - **removed from DB** |
| `429` | Rate Limited | Too many requests to FCM/APNS - **logged** |
| `4xx` | Client Error | Invalid request - check payload format |
| `5xx` | Server Error | Temporary failure - retry later |

**Current Implementation:**
- Automatic cleanup of expired/invalid tokens (410, 404)
- Rate limit awareness (429 logged)
- Graceful error handling with detailed logging

---

## 5. Content Encoding

**Default:** `aes128gcm` (latest standard)

**Options:**
```javascript
// Not needed in options - auto-negotiated
// Left here for reference:
// contentEncoding: 'aes128gcm'  // Modern browsers (2019+) - DEFAULT
// contentEncoding: 'aesgcm'     // Legacy browsers (2017-2018) - DEPRECATED
```

**Decision:** Use default (aes128gcm). Legacy browser support is not worth the security trade-off.

---

## 6. Full Advanced Configuration Example

For future customization, here's the complete options object:

```javascript
const options = {
    // Delivery & Reliability
    TTL: 86400,                      // 24 hours - max retry period
    urgency: 'high',                 // FCM: high priority immediate delivery
    topic: tag,                      // Collapse key - dedupe offline queue
    
    // Apple APNS Headers
    headers: {
        'apns-priority': '10',       // MAX priority for user alerts
        'apns-push-type': 'alert',   // User-visible (not background)
        'apns-expiration': Math.floor(Date.now() / 1000) + 86400,  // Expires 24h
        // Optional additional headers for future features:
        // 'apns-topic': 'com.example.app',  // Bundle ID (usually auto-set)
        // 'apns-collapse-id': tag,          // Dedup ID
        // 'apns-thread-id': 'inbox',        // Thread grouping
    }
};
```

---

## 7. Monitoring & Statistics

The relay logs push statistics:
- `registrations` - Total registered devices
- `pushesToday` - Pushes sent in last 24 hours
- `push_sent` - Successful deliveries
- `token_expired` - Cleaned up invalid tokens
- `rate_limited` - FCM/APNS rate limit events
- `invalid_pow` - Failed Proof-of-Work validations

Monitor via:
```bash
tail -f relay.log | grep "Stats:"
```

---

## 8. Native Android (FCM data-only)

Native Android clients cannot use Web Push — they register an FCM token instead (`{fcmToken}` in place of a Web Push subscription). When `FCM_SERVICE_ACCOUNT` is configured, the relay delivers those over the `firebase-admin` SDK:

```javascript
// Deliberately DATA-ONLY: an FCM `notification` block would be drawn by the
// system before app code runs. Data-only keeps the tag check — and the
// decision to show anything at all — in the client, exactly like the
// service worker does on web.
data: { type: 'wake', tag, channelType, timestamp },
android: {
    priority: 'high',        // mirrors urgency: 'high' on Web Push
    ttl: 86400 * 1000,       // 24h, mirrors TTL
    collapseKey: String(tag) // mirrors topic-based dedup
}
```

Stale FCM tokens (`registration-token-not-registered`) are removed from the database automatically, mirroring the 404/410 cleanup on Web Push.

### Other APNS push types, for reference

```javascript
// For background sync (app wakes in background)
'apns-priority': '5',
'apns-push-type': 'background',

// For VoIP calls
'apns-push-type': 'voip',

// For Apple Watch complications
'apns-push-type': 'complication',
```

---

## References

- [Web Push Protocol (RFC 8030)](https://tools.ietf.org/html/rfc8030)
- [Apple APNS Documentation](https://developer.apple.com/documentation/usernotifications/sending_notification_requests_to_apns)
- [Google FCM Documentation](https://firebase.google.com/docs/cloud-messaging/http-server-ref)
- [web-push Library](https://github.com/web-push-libs/web-push)
