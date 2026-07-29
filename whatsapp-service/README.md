# SAMS WhatsApp Worker

Standalone Node.js process that sends WhatsApp notifications for SAMS.
**Best-effort, unofficial, entirely optional** — see the "WhatsApp
Notifications" section of the root `CLAUDE.md` for the full design and
disclaimer. This directory is a separate deployable: its own
`package.json`, its own dependencies, deployed and run independently of
the Next.js app. It talks to the main app only through two shared
Postgres tables (`whatsapp_notification_logs`, `whatsapp_settings`) —
never a direct network call in either direction.

## What it does

1. Logs into WhatsApp once via QR code (WhatsApp Web protocol, using
   [Baileys](https://github.com/WhiskeySockets/Baileys)) and persists
   the session to disk so it survives restarts.
2. Polls `whatsapp_notification_logs` for `PENDING` rows every
   `POLL_INTERVAL_MS` and sends each as a plain WhatsApp text message.
3. Writes `SENT` / `FAILED` (with the error) back to that same row.
4. Writes a heartbeat + live connection status into `whatsapp_settings`
   every `HEARTBEAT_INTERVAL_MS`, which is what the admin's
   **Admin → WhatsApp** page reads to show Connected / Disconnected /
   Needs QR re-scan.

It never enqueues anything itself — the main app does that (see
`lib/whatsapp-notify.ts`) whenever results are published, a leave notice
is logged, or a timetable slot changes, and only if the admin has the
feature turned on.

## VPS setup

Requirements: Node.js 20+, network access to your Neon Postgres
database, and a persistent disk (a normal VPS filesystem is fine — this
is NOT for a serverless/ephemeral host, since the session directory must
survive restarts).

```bash
# 1. Get this directory onto the VPS (clone the whole repo, or rsync
#    just whatsapp-service/ — it doesn't need the rest of the app).
git clone <your-repo-url>
cd sams/whatsapp-service

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL to the SAME Neon database the main app
# uses — the DIRECT (non-pooled) connection string, since this is a
# long-running process with its own persistent connection, not
# serverless/pooled like Vercel.

# 4. First run — this is the ONE-TIME QR scan
npm start
# A QR code prints in the terminal. On the phone that owns the WhatsApp
# number you're dedicating to this feature: WhatsApp → Settings →
# Linked Devices → Link a Device → scan it.
# Once scanned, the log prints "WhatsApp connected." and the session is
# saved to ./auth_session (path configurable via SESSION_DIR).
```

### Keeping it running persistently

Use a process manager so it survives SSH disconnects and reboots.
[pm2](https://pmnpm.keymetrics.io/) is the simplest option:

```bash
npm install -g pm2
pm2 start "npm start" --name sams-whatsapp
pm2 save
pm2 startup   # follow the printed instructions to enable on-boot start
```

Or a plain systemd unit (`/etc/systemd/system/sams-whatsapp.service`):

```ini
[Unit]
Description=SAMS WhatsApp notification worker
After=network.target

[Service]
WorkingDirectory=/path/to/sams/whatsapp-service
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=<a non-root user>

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now sams-whatsapp`.

### How session persistence works

Baileys' `useMultiFileAuthState` writes the session's cryptographic
credentials as a handful of JSON files under `SESSION_DIR`
(`./auth_session` by default). As long as that directory survives a
restart, the process reconnects automatically — no QR code needed again.
Treat this directory like a password: it is NOT in git (`.gitignore`
excludes it), and if you migrate to a new VPS, copy it across rather
than re-scanning (though re-scanning is always a safe fallback if you'd
rather not move it).

### Re-scanning the QR code (session dropped or the number got logged out)

If the phone unlinks the device (or WhatsApp bans/logs out the number),
the worker's log will say something like:

```
WhatsApp session was logged out. Delete ./auth_session and restart this
process to scan a new QR code.
```

The admin's **Admin → WhatsApp** page will also show **"Needs QR
re-scan"**. To fix it:

```bash
pm2 stop sams-whatsapp        # or: systemctl stop sams-whatsapp
rm -rf auth_session
pm2 start sams-whatsapp       # or: systemctl start sams-whatsapp
pm2 logs sams-whatsapp        # watch for the QR code, scan it again
```

Nothing else needs to change — the queue in `whatsapp_notification_logs`
is untouched by this, so anything that was `PENDING` during the outage
gets sent as soon as the worker reconnects (and anything the admin
turned off/on via the toggle is respected as always).

## Ban-risk disclaimer

This uses an **unofficial** library that automates a real WhatsApp
number via the WhatsApp Web protocol — it is not the official Meta
Business API. WhatsApp's Terms of Service prohibit this kind of
automation, and the number used here can be banned or rate-limited at
any time, without warning, for any reason. That risk is accepted
knowingly for this project (see CLAUDE.md). Dedicate a number you're
comfortable losing access to; do not use anyone's primary personal
number.
