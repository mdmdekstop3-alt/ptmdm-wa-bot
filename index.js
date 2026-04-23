import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  makeInMemoryStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import express from 'express';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════
// CONFIG — isi setelah deploy ke Railway
// ═══════════════════════════════════════════════
const CONFIG = {
  // URL webhook n8n Anda
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || 'https://GANTI-URL-N8N.railway.app/webhook/wa-ptmdm',

  // Nomor admin yang boleh pakai bot (format: 6281xxx tanpa + atau spasi)
  ADMIN_NUMBERS: (process.env.ADMIN_NUMBERS || '6281234567890').split(',').map(n => n.trim()),

  // OpenAI API key untuk Whisper (transkripsi voice note)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  // Port server
  PORT: process.env.PORT || 3000,
};

// ═══════════════════════════════════════════════
// EXPRESS SERVER (health check + QR endpoint)
// ═══════════════════════════════════════════════
const app = express();
app.use(express.json());

let qrCodeData = '';
let waStatus = 'disconnected';
let waSocket = null;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>PT MDM WA Bot</title>
      <meta http-equiv="refresh" content="10">
      <style>
        body { font-family: monospace; background: #0f172a; color: #e2e8f0; padding: 2rem; }
        h1 { color: #10b981; }
        .status { padding: .5rem 1rem; border-radius: 8px; display: inline-block; margin: 1rem 0; }
        .connected { background: rgba(16,185,129,.2); color: #10b981; border: 1px solid #10b981; }
        .disconnected { background: rgba(239,68,68,.2); color: #ef4444; border: 1px solid #ef4444; }
        .waiting { background: rgba(245,158,11,.2); color: #f59e0b; border: 1px solid #f59e0b; }
        img { border: 2px solid #10b981; border-radius: 8px; margin-top: 1rem; }
        pre { background: #1e293b; padding: 1rem; border-radius: 8px; font-size: .8rem; }
      </style>
    </head>
    <body>
      <h1>🤖 PT MDM WhatsApp Bot</h1>
      <div class="status ${waStatus === 'connected' ? 'connected' : waStatus === 'waiting_qr' ? 'waiting' : 'disconnected'}">
        ${waStatus === 'connected' ? '🟢 Terhubung ke WhatsApp' : waStatus === 'waiting_qr' ? '🟡 Scan QR Code di bawah' : '🔴 Terputus'}
      </div>
      ${waStatus === 'waiting_qr' && qrCodeData ? `
        <p>Buka WhatsApp → Linked Devices → Link a Device → Scan QR ini:</p>
        <img src="${qrCodeData}" width="280" height="280"/>
        <p style="color:#64748b;font-size:.8rem">Halaman auto-refresh setiap 10 detik</p>
      ` : ''}
      ${waStatus === 'connected' ? `
        <pre>✅ Bot aktif dan siap menerima pesan
Admin terdaftar: ${CONFIG.ADMIN_NUMBERS.join(', ')}
Webhook n8n: ${CONFIG.N8N_WEBHOOK_URL}</pre>
      ` : ''}
    </body>
    </html>
  `);
});

app.get('/status', (req, res) => {
  res.json({ status: waStatus, adminNumbers: CONFIG.ADMIN_NUMBERS });
});

// Endpoint untuk kirim pesan balik (dipanggil dari n8n)
app.post('/send', async (req, res) => {
  const { target, message } = req.body;
  if (!target || !message) return res.status(400).json({ error: 'target dan message wajib diisi' });
  if (!waSocket) return res.status(503).json({ error: 'WA belum terhubung' });

  try {
    const jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
    await waSocket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`🌐 Server jalan di port ${CONFIG.PORT}`);
});

// ═══════════════════════════════════════════════
// WHISPER — Transkripsi Voice Note
// ═══════════════════════════════════════════════
async function transkripsiVoice(audioBuffer, mimeType = 'audio/ogg') {
  if (!CONFIG.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY tidak diset, voice note tidak bisa ditranskrip');
    return null;
  }

  try {
    const form = new FormData();
    // Whisper butuh file extension yang benar
    const ext = mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('mp4') ? 'mp4'
      : mimeType.includes('mpeg') ? 'mp3'
      : 'ogg';

    form.append('file', audioBuffer, {
      filename: `voice.${ext}`,
      contentType: mimeType,
    });
    form.append('model', 'whisper-1');
    form.append('language', 'id'); // Bahasa Indonesia

    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      timeout: 30000,
    });

    return resp.data.text || null;
  } catch (err) {
    console.error('Whisper error:', err.response?.data || err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// KIRIM KE N8N WEBHOOK
// ═══════════════════════════════════════════════
async function kirimKeN8n(payload) {
  try {
    const resp = await axios.post(CONFIG.N8N_WEBHOOK_URL, payload, {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
    });
    return resp.data;
  } catch (err) {
    console.error('n8n webhook error:', err.response?.data || err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// BAILEYS — WhatsApp Connection
// ═══════════════════════════════════════════════
async function startWA() {
  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const logger = pino({ level: 'silent' }); // Matikan log verbose Baileys

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false, // Kita handle sendiri
    browser: ['PT MDM Bot', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  waSocket = sock;

  // ─── QR Code ───
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      waStatus = 'waiting_qr';
      // Tampilkan di terminal
      qrcode.generate(qr, { small: true });
      console.log('\n📱 Scan QR di atas dengan WhatsApp Anda');
      console.log(`🌐 Atau buka: http://localhost:${CONFIG.PORT} untuk lihat QR di browser\n`);

      // Convert QR ke data URL untuk ditampilkan di web
      try {
        const { default: QRCode } = await import('qrcode');
        qrCodeData = await QRCode.toDataURL(qr);
      } catch (e) {
        // qrcode optional
      }
    }

    if (connection === 'open') {
      waStatus = 'connected';
      qrCodeData = '';
      console.log('✅ WhatsApp terhubung! Bot siap.');
      console.log(`👥 Admin terdaftar: ${CONFIG.ADMIN_NUMBERS.join(', ')}`);
    }

    if (connection === 'close') {
      waStatus = 'disconnected';
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Koneksi terputus:', lastDisconnect?.error?.message || 'unknown');
      if (shouldReconnect) {
        console.log('🔄 Mencoba reconnect...');
        setTimeout(startWA, 5000);
      } else {
        console.log('🚪 Logged out. Hapus folder auth_info dan restart untuk scan QR ulang.');
        // Hapus auth agar bisa scan ulang
        fs.rmSync(authDir, { recursive: true, force: true });
        setTimeout(startWA, 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Handle Pesan Masuk ───
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip pesan dari diri sendiri
      if (msg.key.fromMe) continue;

      const sender  = msg.key.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', '') || '';
      const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;

      // Skip pesan grup (bot hanya untuk private chat)
      if (isGroup) continue;

      const senderName = msg.pushName || 'User';
      const msgType    = Object.keys(msg.message || {})[0] || 'unknown';

      console.log(`📨 Pesan dari ${senderName} (${sender}): [${msgType}]`);

      // ─── Cek apakah admin ───
      const isAdmin = CONFIG.ADMIN_NUMBERS.some(n =>
        sender.replace(/[^0-9]/g, '').includes(n.replace(/[^0-9]/g, ''))
      );

      if (!isAdmin) {
        await sock.sendMessage(msg.key.remoteJid, {
          text: '⛔ Maaf, nomor Anda tidak terdaftar sebagai admin PT MDM.',
        });
        continue;
      }

      // ─── Proses berdasarkan tipe pesan ───
      try {
        if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
          // ── Pesan teks biasa ──
          const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || '';

          await kirimKeN8n({
            type: 'text',
            sender,
            senderName,
            message: text.trim(),
            timestamp: new Date().toISOString(),
            replyJid: msg.key.remoteJid,
          });

        } else if (msgType === 'audioMessage') {
          // ── Voice Note ──
          console.log(`🎤 Voice note dari ${senderName}, mencoba transkripsi...`);

          await sock.sendMessage(msg.key.remoteJid, {
            text: '🎤 Sedang memproses voice note...',
          });

          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const mimeType = msg.message.audioMessage?.mimetype || 'audio/ogg; codecs=opus';
            const teks = await transkripsiVoice(buffer, mimeType);

            if (teks) {
              console.log(`📝 Transkripsi: "${teks}"`);
              // Kirim ke n8n sebagai teks biasa
              await kirimKeN8n({
                type: 'voice',
                sender,
                senderName,
                message: teks,
                originalType: 'audio',
                timestamp: new Date().toISOString(),
                replyJid: msg.key.remoteJid,
              });
            } else {
              await sock.sendMessage(msg.key.remoteJid, {
                text: '⚠️ Maaf, voice note tidak bisa ditranskrip. Coba ketik pesannya ya.',
              });
            }
          } catch (dlErr) {
            console.error('Download audio error:', dlErr.message);
            await sock.sendMessage(msg.key.remoteJid, {
              text: '⚠️ Gagal proses voice note. Silakan ketik pesannya.',
            });
          }

        } else if (msgType === 'imageMessage') {
          // ── Foto ──
          console.log(`📸 Foto dari ${senderName}, mendownload...`);

          await sock.sendMessage(msg.key.remoteJid, {
            text: '📸 Foto diterima, sedang dibaca AI...',
          });

          try {
            const buffer  = await downloadMediaMessage(msg, 'buffer', {});
            const mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
            const caption  = msg.message.imageMessage?.caption || '';
            const base64   = buffer.toString('base64');

            await kirimKeN8n({
              type: 'image',
              sender,
              senderName,
              message: caption,
              base64Image: base64,
              mimeType,
              timestamp: new Date().toISOString(),
              replyJid: msg.key.remoteJid,
            });
          } catch (dlErr) {
            console.error('Download image error:', dlErr.message);
            await sock.sendMessage(msg.key.remoteJid, {
              text: '⚠️ Gagal download foto. Coba kirim ulang.',
            });
          }

        } else {
          // Tipe pesan lain (sticker, dokumen, dll)
          await sock.sendMessage(msg.key.remoteJid, {
            text: '📎 Maaf, saya hanya bisa baca teks, voice note, dan foto ya.',
          });
        }

      } catch (err) {
        console.error('Error proses pesan:', err.message);
        await sock.sendMessage(msg.key.remoteJid, {
          text: '⚠️ Terjadi kesalahan. Coba lagi ya.',
        });
      }
    }
  });

  return sock;
}

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
console.log('🚀 PT MDM WhatsApp Bot starting...');
console.log(`📡 Webhook n8n: ${CONFIG.N8N_WEBHOOK_URL}`);
startWA().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
