import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import {
  getSettings,
  getPendingNotifications,
  markSent,
  markFailed,
  setConnectionStatus,
  heartbeat,
} from "./db.js";

const SESSION_DIR = process.env.SESSION_DIR || "./auth_session";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 30000;
// A short delay between individual sends within one poll batch — spreads
// messages out instead of firing a burst, which lowers the chance of
// WhatsApp flagging the number for automated/spam-like behavior. This is
// a best-effort mitigation, not a guarantee — see CLAUDE.md's ban-risk
// disclaimer.
const INTER_MESSAGE_DELAY_MS = 1500;

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

let sock: WASocket | null = null;

function toJid(phoneNumber: string): string {
  const digitsOnly = phoneNumber.replace(/[^0-9]/g, "");
  return `${digitsOnly}@s.whatsapp.net`;
}

async function startSocket(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    logger: logger.child({ module: "baileys" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan this QR code with WhatsApp (Linked Devices):");
      qrcodeTerminal.generate(qr, { small: true });
      await setConnectionStatus("NEEDS_QR_SCAN");
    }

    if (connection === "open") {
      logger.info("WhatsApp connected.");
      await setConnectionStatus("CONNECTED");
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
  });
}

async function pollAndSend(): Promise<void> {
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
  }
}

async function main(): Promise<void> {
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
