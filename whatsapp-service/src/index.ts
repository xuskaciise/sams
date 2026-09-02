import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import {
  getSettings,
  getPendingNotifications,
  markSent,
  markFailed,
  setConnectionStatus,
  heartbeat,
} from "./db.js";

const SESSION_DIR = process.env.SESSION_DIR || "./auth_session";
// Alternative to scanning a QR code entirely: WhatsApp on the target
// phone -> Settings -> Linked Devices -> Link a Device -> "Link with
// phone number instead" -> type the 8-character code this worker logs.
// Sidesteps every QR-image failure mode (camera, distortion, staleness,
// batch timeout) since no image is involved at all — set this to the
// E.164 digits (no "+", e.g. "252611111111") of the number being linked
// to use it.
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || null;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 30000;
// Delay between individual sends — the queue is drained at a controlled
// ONE MESSAGE PER 5 SECONDS, never in a burst. This matters most for the
// manual "Send timetable notifications" action, which can enqueue
// hundreds of rows in one click (every student in a semester batch): the
// worker still trickles them out at this pace so it never looks like
// automated bulk spam to WhatsApp. Best-effort mitigation, not a
// guarantee — see CLAUDE.md's ban-risk disclaimer. Overridable via env.
const INTER_MESSAGE_DELAY_MS = Number(process.env.INTER_MESSAGE_DELAY_MS) || 5000;

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Terminal ASCII QR art is fragile the moment it's relayed through
// anything other than a real monospace terminal (chat clients, SSH
// clients with proportional-font fallback, line-wrapping at narrow
// widths) — block characters get subtly distorted and the phone camera
// then reads a corrupted pattern, which WhatsApp's app reports as
// "Couldn't link device" with zero server-side trace (the request never
// even reaches Baileys, since the phone rejected the decode locally).
// Writing a real PNG file sidesteps all of that: open QR_PNG_PATH
// directly and scan it — no chat/terminal relay involved.
const QR_PNG_PATH = path.resolve(process.cwd(), "qr.png");

let sock: WASocket | null = null;

function toJid(phoneNumber: string): string {
  const digitsOnly = phoneNumber.replace(/[^0-9]/g, "");
  return `${digitsOnly}@s.whatsapp.net`;
}

async function requestPairingCodeWhenReady(
  activeSock: WASocket,
  phoneNumber: string
): Promise<void> {
  try {
    // makeWASocket() only STARTS connecting — the noise handshake
    // ("connected to WA" in the baileys logs) finishes a beat later.
    // Calling requestPairingCode() before that completes sends the
    // pairing request over a socket that isn't open yet, which WhatsApp
    // rejects (428 "Connection Closed") and can cascade into a spurious
    // "logged out" disconnect. Baileys doesn't expose a clean event for
    // "handshake done, safe to send" here, so a short fixed delay is the
    // standard workaround used throughout the Baileys community for
    // this exact race.
    await sleep(3000);
    const code = await activeSock.requestPairingCode(phoneNumber);
    logger.info(
      `Pairing code: ${code} — on WhatsApp for +${phoneNumber}: Settings > Linked Devices > Link a Device > "Link with phone number instead", then type this code. No QR/camera involved.`
    );
    await setConnectionStatus("NEEDS_QR_SCAN");
  } catch (error) {
    logger.error({ error }, "requestPairingCode failed");
  }
}

async function startSocket(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    logger: logger.child({ module: "baileys" }),
  });

  sock.ev.on("creds.update", saveCreds);

  if (PAIRING_PHONE_NUMBER && !state.creds.registered) {
    // Fire-and-forget, deliberately NOT awaited here — it must not delay
    // attaching the connection.update listener below, or every event
    // fired during the wait (see the comment inside) would have no
    // listener and be silently lost.
    void requestPairingCodeWhenReady(sock, PAIRING_PHONE_NUMBER);
  }

  sock.ev.on("connection.update", async (update) => {
    try {
      await handleConnectionUpdate(update);
    } catch (error) {
      // Defense in depth on top of setConnectionStatus's own internal
      // try/catch (lib/db.ts) — this whole handler must never throw, or
      // an unhandled rejection here brings down the entire worker (see
      // the "Connection terminated unexpectedly" crash this replaced).
      logger.error({ error }, "connection.update handler failed (non-fatal)");
    }
  });
}

async function handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
  const { connection, lastDisconnect, qr } = update;

  if (qr && !PAIRING_PHONE_NUMBER) {
    logger.info("Scan this QR code with WhatsApp (Linked Devices):");
    qrcodeTerminal.generate(qr, { small: true });
    try {
      await QRCode.toFile(QR_PNG_PATH, qr, { width: 512, margin: 2 });
      logger.info(
        `A clean PNG version was also saved to ${QR_PNG_PATH} — open that file directly and scan it if the terminal art above doesn't scan (much more reliable, since it isn't relayed through any terminal/chat rendering).`
      );
    } catch (error) {
      logger.error({ error }, "failed to write qr.png");
    }
    await setConnectionStatus("NEEDS_QR_SCAN");
  }

  if (connection === "open") {
    logger.info("WhatsApp connected.");
    await setConnectionStatus("CONNECTED");
    // Stale QR image would otherwise sit on disk looking scannable —
    // remove it now that pairing succeeded.
    await fs.rm(QR_PNG_PATH, { force: true });
  }

  if (connection === "close") {
    // `lastDisconnect.error` is a Boom error whose HTTP-style status
    // code tells us WHY the socket closed. A 401 (loggedOut) means the
    // session itself was invalidated on the phone side (user removed
    // the linked device) — reconnecting won't help, a fresh QR scan is
    // required. Anything else (network blip, restart, etc.) is
    // recoverable by just reconnecting.
    const statusCode = (
      lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
    )?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    await setConnectionStatus(loggedOut ? "NEEDS_QR_SCAN" : "DISCONNECTED");

    if (loggedOut) {
      logger.warn(
        `WhatsApp session was logged out. Delete ${SESSION_DIR} and restart this process to scan a new QR code.`
      );
    } else {
      logger.warn("Connection closed, reconnecting in 3s...");
      await sleep(3000);
      void startSocket();
    }
  }
}

// One poll batch takes INTER_MESSAGE_DELAY_MS per pending row, which is
// far longer than POLL_INTERVAL_MS — so without this guard the setInterval
// below would stack up many overlapping pollAndSend runs, all fetching the
// same still-PENDING rows and sending them in parallel, which both
// double-sends and defeats the whole one-message-per-5s pacing. Only ever
// run one batch at a time; the next tick that fires mid-batch simply
// returns and the batch continues.
let batchInFlight = false;

async function pollAndSend(): Promise<void> {
  if (batchInFlight) return;
  batchInFlight = true;
  try {
    const settings = await getSettings();
    if (!settings?.enabled) return; // admin kill switch — leave queue as-is
    if (!sock || settings.connection_status !== "CONNECTED") return;

    const pending = await getPendingNotifications();
    for (const notification of pending) {
      try {
        await sock.sendMessage(toJid(notification.phone_number), {
          text: notification.message,
        });
        await markSent(notification.id);
      } catch (error) {
        await markFailed(
          notification.id,
          error instanceof Error ? error.message : String(error)
        );
      }
      await sleep(INTER_MESSAGE_DELAY_MS);
    }
  } catch (error) {
    logger.error({ error }, "poll cycle failed");
  } finally {
    batchInFlight = false;
  }
}

async function main(): Promise<void> {
  // Last-resort safety net: this process's entire job is to stay alive
  // indefinitely, so nothing anywhere should ever be able to take it
  // down. Everything reachable from the event loop above (pool errors,
  // setConnectionStatus/heartbeat, the connection.update handler,
  // pollAndSend) already catches its own errors — this is a backstop for
  // whatever wasn't anticipated, not a substitute for those. Logs and
  // keeps running rather than crashing, which is exactly what the
  // "Connection terminated unexpectedly" crash this replaces needed.
  process.on("unhandledRejection", (error) => {
    logger.error({ error }, "unhandled rejection (worker continues running)");
  });
  process.on("uncaughtException", (error) => {
    logger.error({ error }, "uncaught exception (worker continues running)");
  });

  logger.info("Starting SAMS WhatsApp worker...");
  await setConnectionStatus("DISCONNECTED");
  await startSocket();

  setInterval(() => void pollAndSend(), POLL_INTERVAL_MS);
  setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
}

main().catch((error) => {
  logger.error({ error }, "fatal startup error");
  process.exitCode = 1;
});
