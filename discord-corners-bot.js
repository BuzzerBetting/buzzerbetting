// discord-corners-bot.js
//
// Watches one Discord channel for Betfred corner bet-builder screenshots and books each one
// as a 'Corners' bet via the DO server. All the real work (parse, validate, book, dedupe,
// audit) is server-side in ledger-routes.js POST /discord-corners-book — this file is just a
// gateway relay that forwards the image URL and reacts to the message with the outcome.
//
// Behaviour:
//   - Toggle OFF (site): the bot does nothing — no reaction, no record.
//   - Toggle ON: live screenshots are booked as they arrive, AND on the flip-to-on the bot
//     catches up on every slip posted since the last one it reacted to (server sets
//     config.catchup_from; the bot works through it, then clears it).
//
// Runs as its own PM2 process on the DO box alongside server.js. Requires:
//   DISCORD_BOT_TOKEN            - bot token (Reset Token in the Discord dev portal)
//   LEDGER_API_KEY               - same value server.js uses (already set for the app)
//   DISCORD_CORNERS_ALLOWED_IDS  - optional; comma-separated Discord user IDs to accept
//   DISCORD_CORNERS_CHANNEL_ID   - optional; defaults to the corner-bets channel below
//   PORT                         - optional; the DO server port, defaults to 3000
const { Client, GatewayIntentBits } = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const KEY = process.env.LEDGER_API_KEY;
const CHANNEL_ID = process.env.DISCORD_CORNERS_CHANNEL_ID || '1347882651004047420';
const ALLOWED_IDS = (process.env.DISCORD_CORNERS_ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const BASE = `http://localhost:${process.env.PORT || 3000}/api/ledger`;

if (!TOKEN) { console.error('[discord-corners] DISCORD_BOT_TOKEN not set — exiting'); process.exit(1); }
if (!KEY) { console.error('[discord-corners] LEDGER_API_KEY not set — exiting'); process.exit(1); }

const EMOJI = { booked: '✅', skipped: '⚠️', error: '❌', duplicate: '🔁' };
const HDRS = { 'Content-Type': 'application/json', 'x-ledger-key': KEY };

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
  console.log(`[discord-corners] logged in as ${client.user.tag}; watching channel ${CHANNEL_ID}`);
  setInterval(pollCatchup, 30000);
});
client.on('error', (e) => console.error('[discord-corners] client error:', e.message));

function isImage(att) {
  return (att.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp)(\?|$)/i.test(att.name || att.url || '');
}
function fromAllowedSender(msg) {
  return !msg.author.bot && (!ALLOWED_IDS.length || ALLOWED_IDS.includes(msg.author.id));
}
async function getConfig() {
  try {
    const d = await (await fetch(`${BASE}/discord-corners-config`, { headers: HDRS })).json();
    return d && d.ok ? d : null;
  } catch (e) { return null; }
}

// Book one image and react to its message. Shared by the live handler and the catch-up.
async function processImage(msg, img) {
  try {
    const r = await fetch(`${BASE}/discord-corners-book`, {
      method: 'POST', headers: HDRS,
      body: JSON.stringify({ message_id: msg.id, channel_id: msg.channelId, image_url: img.url }),
    });
    const d = await r.json().catch(() => ({}));
    const status = d.status || 'error';
    console.log(`[discord-corners] msg ${msg.id} -> ${status}${d.note ? ' (' + d.note + ')' : ''}`);
    if (status === 'disabled') return; // shouldn't happen (we check first) — but never react
    await msg.react(EMOJI[status] || '❓').catch(() => {});
    if (status === 'booked') await msg.reply(`✅ Booked: ${d.summary}`).catch(() => {});
    else if (status === 'skipped' || status === 'error') await msg.reply(`${EMOJI[status]} ${d.note || status}`).catch(() => {});
  } catch (e) {
    console.error('[discord-corners] book request failed:', e.message);
    await msg.react('❌').catch(() => {});
  }
}

// ---- live ----
client.on('messageCreate', async (msg) => {
  if (msg.channelId !== CHANNEL_ID) return;
  const images = [...msg.attachments.values()].filter(isImage);
  if (!images.length) return;
  console.log(`[discord-corners] image from ${msg.author.tag} (${msg.author.id})`);
  if (!fromAllowedSender(msg)) { console.log('[discord-corners] ignored — sender not allowed'); return; }
  const cfg = await getConfig();
  if (!cfg || !cfg.enabled || !cfg.account_id) return; // toggle off => nothing happens
  for (const img of images) await processImage(msg, img);
});

// ---- catch-up on flip-to-on ----
let catchingUp = false;
async function pollCatchup() {
  if (catchingUp) return;
  const cfg = await getConfig();
  if (!cfg || !cfg.enabled || !cfg.account_id || !cfg.catchup_from) return;
  catchingUp = true;
  let after = cfg.catchup_from;
  let processed = 0;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    for (let page = 0; page < 20; page++) {         // safety cap ~2000 messages
      const batch = await channel.messages.fetch({ after, limit: 100 });
      if (!batch.size) break;
      const asc = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const m of asc) {
        if (!fromAllowedSender(m)) continue;
        for (const img of [...m.attachments.values()].filter(isImage)) { await processImage(m, img); processed++; }
      }
      after = asc[asc.length - 1].id;               // advance forward to the newest we just saw
      if (batch.size < 100) break;
    }
    console.log(`[discord-corners] catch-up done — processed ${processed} slip(s) since ${cfg.catchup_from}`);
  } catch (e) {
    console.error('[discord-corners] catch-up failed:', e.message);
  } finally {
    await fetch(`${BASE}/discord-corners-catchup-clear`, { method: 'POST', headers: HDRS }).catch(() => {});
    catchingUp = false;
  }
}

client.login(TOKEN);
