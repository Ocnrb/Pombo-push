# Pombo Relay - Admin Commands Guide

## Two Ways to Manage the Relay

### 1. **Admin HTTP API** (while relay is running)

The relay now starts an **Admin API on port 8000** that you can query from any HTTP client.

#### Start the relay:
```bash
npm start
```

You'll see:
```
✅ Admin API listening on port 8000
   Documentation: http://localhost:8000/admin/help
```

#### API Endpoints:

##### Get Statistics
```bash
curl http://localhost:8000/admin/stats
```

**Response:**
```json
{
  "registrations": 245,
  "pushesToday": 1203,
  "byTag": [
    {
      "tag": "pombo/chat",
      "count": 120
    },
    {
      "tag": "pombo/dm",
      "count": 89
    }
  ],
  "relayAddress": "0x123...",
  "stream": "pombo/push/notifications"
}
```

##### List All Registrations
```bash
curl http://localhost:8000/admin/registrations
```

##### Filter by Tag
```bash
curl "http://localhost:8000/admin/registrations?tag=pombo/chat"
```

**Response:**
```json
{
  "count": 120,
  "tag": "pombo/chat",
  "registrations": [
    {
      "id": 1,
      "tag": "pombo/chat",
      "token": "https://fcm.googleapis.com/...",
      "created": "2026-04-30T10:15:23.000Z",
      "updated": "2026-04-30T12:45:11.000Z"
    }
  ]
}
```

##### Get Recent Events
```bash
curl "http://localhost:8000/admin/events?limit=50"
```

**Response:**
```json
{
  "count": 50,
  "events": [
    {
      "event": "push_sent",
      "details": "{\"tag\":\"pombo/chat\",\"sent\":15,\"failed\":0}",
      "time": "2026-04-30T13:00:00.000Z"
    },
    {
      "event": "registration",
      "details": "pombo/chat",
      "time": "2026-04-30T12:50:30.000Z"
    }
  ]
}
```

##### Delete All Tokens for a Tag
```bash
curl -X DELETE http://localhost:8000/admin/registrations/pombo/chat
```

**Response:**
```json
{
  "message": "Deleted 120 devices for tag: pombo/chat",
  "deleted": 120
}
```

---

### 2. **Admin CLI Tool** (standalone commands)

Use the CLI for direct database management without running the relay.

#### Installation:
The tool is included as `admin-cli.js` in the relay directory.

#### Available Commands:

##### Show Help
```bash
node admin-cli.js help
```

##### List All Registrations
```bash
node admin-cli.js list
```

**Output:**
```
═══════════════════════════════════════════════════════════
  📋 REGISTRATIONS
═══════════════════════════════════════════════════════════

  📌 Tag: pombo/chat (120 devices)
     [1] https://fcm.googleapis.com/...
         Created: 2026-04-30T10:15:23.000Z
     [2] https://fcm.googleapis.com/...
         Created: 2026-04-29T15:42:10.000Z

  📌 Tag: pombo/dm (89 devices)
     [1] https://fcm.googleapis.com/...
         Created: 2026-04-30T09:20:05.000Z
```

##### Filter by Specific Tag
```bash
node admin-cli.js list pombo/chat
```

##### Show Statistics
```bash
node admin-cli.js stats
```

**Output:**
```
═══════════════════════════════════════════════════════════
  📊 STATISTICS
═══════════════════════════════════════════════════════════

  📈 OVERALL
  Total registrations:   245
  Total events logged:   3456

  📅 LAST 24 HOURS
  New registrations:     45
  Pushes sent:           1203

  🏷️  BY TAG
  pombo/chat             120 devices
  pombo/dm               89 devices

  📋 EVENT LOG BREAKDOWN
  push_sent              1203
  registration           45
  token_expired          12
  invalid_pow            2

  ⚠️  ISSUES
  Expired tokens:        12
```

##### Show Recent Events
```bash
node admin-cli.js events 100
```

**Output:**
```
═══════════════════════════════════════════════════════════
  📜 RECENT EVENTS (Last 100)
═══════════════════════════════════════════════════════════

  [1] 2026-04-30T13:00:05.000Z | push_sent
       → {"tag":"pombo/chat","sent":15,"failed":0}
  [2] 2026-04-30T13:00:02.000Z | registration
       → pombo/dm
  [3] 2026-04-30T12:59:50.000Z | push_sent
       → {"tag":"pombo/dm","sent":8,"failed":1}
```

##### Delete All Tokens for a Tag (with confirmation)
```bash
# See what will be deleted
node admin-cli.js delete pombo/chat

# Actually delete (requires --force flag)
node admin-cli.js delete pombo/chat --force
```

##### Delete Specific Token
```bash
# Find and delete a specific token
node admin-cli.js delete pombo/chat "https://fcm..." --force
```

##### Clean Expired Tokens (not updated in 30+ days)
```bash
# Preview what will be deleted
node admin-cli.js clean-expired

# Actually delete (requires --force flag)
node admin-cli.js clean-expired --force
```

##### Export All Data to JSON
```bash
node admin-cli.js export
```

**Creates:** `pombo-relay-export-1234567890.json`

**Format:**
```json
{
  "exportedAt": "2026-04-30T13:00:00.000Z",
  "summary": {
    "registrations": 245,
    "recentEvents": 1000
  },
  "data": {
    "registrations": [...],
    "stats": [...]
  }
}
```

---

## Comparison: API vs CLI

| Task | API | CLI |
|------|-----|-----|
| View stats | ✅ Real-time | ✅ Snapshot |
| List tokens | ✅ Filtered | ✅ With details |
| Delete tokens | ✅ HTTP DELETE | ✅ With --force |
| Clean expired | ❌ | ✅ With safety prompt |
| Export data | ❌ | ✅ To JSON file |
| Requires relay running | ✅ | ❌ |
| Remote access | ✅ | ❌ |
| Automation/scripting | ✅ | ✅ |

---

## Example Workflows

### Check if relay is healthy
```bash
curl http://localhost:8000/admin/stats | jq '.registrations, .pushesToday'
```

### Monitor specific tag
```bash
curl "http://localhost:8000/admin/registrations?tag=pombo/chat" | jq '.count'
```

### Cleanup old devices (once per week)
```bash
node admin-cli.js clean-expired --force
```

### Backup data before maintenance
```bash
node admin-cli.js export
```

### Remove problematic tag
```bash
curl -X DELETE http://localhost:8000/admin/registrations/pombo/spam
```

### Check for errors
```bash
curl "http://localhost:8000/admin/events?limit=200" | jq '.events[] | select(.event | test("error|failed"))'
```

---

## Port Configuration

By default, Admin API uses **port 8000**.

To change it, set the environment variable:
```bash
export ADMIN_PORT=9000
npm start
```

Or in `.env`:
```
ADMIN_PORT=9000
```

To disable the Admin API entirely, set `ADMIN_PORT=0` — the offline CLI (`admin-cli.js`) keeps working without it.

---

## Security Notes

⚠️ **The Admin API is currently open to all clients on the network!**

For production:
- Add authentication (JWT token in header)
- Only allow localhost access (set `127.0.0.1` in listen)
- Use firewall rules to restrict access

Example (port 8000 only for localhost):
```javascript
adminServer.listen(ADMIN_PORT, '127.0.0.1');
```

---

## Troubleshooting

### "Database not found" error
```bash
# CLI requires relay to have been run at least once
npm start
# (let it initialize, then Ctrl+C)
node admin-cli.js list
```

### Can't connect to API
```bash
# Check if relay is running
curl http://localhost:8000/admin/stats

# Check if port is in use
lsof -i :8000  # macOS/Linux
netstat -ano | findstr :8000  # Windows
```

### Delete not working
```bash
# Forgot --force flag
node admin-cli.js delete pombo/chat --force

# Or use API
curl -X DELETE http://localhost:8000/admin/registrations/pombo/chat
```
