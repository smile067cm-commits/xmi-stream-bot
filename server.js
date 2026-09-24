/**
 * ==============================================================================
 * 🎥 XMI TELEGRAM VIDEO STREAMING SERVER
 * High-performance MTProto & HTTP Range Video Streaming Server for Render
 * ==============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8636298353:AAG51fEmR_gKaj8kZ09NV_p-833RJfE5dPU';
const API_ID = Number(process.env.API_ID || 34704016);
const API_HASH = process.env.API_HASH || '68a7cd3c57fe18aedc2a29984183a29e';
const DEFAULT_CHANNEL_ID = process.env.CHANNEL_ID || '-1004415998750';

// Enable CORS for all domains so Telegram WebApps and browsers can stream videos
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Authorization', 'Accept'],
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'Content-Type']
}));

let client = null;
let clientReady = false;
let clientInitPromise = null;
const mediaCache = new Map();

// Initialize GramJS MTProto Telegram Client
async function getTelegramClient() {
  if (clientReady && client) return client;
  if (clientInitPromise) return clientInitPromise;

  if (!API_ID || !API_HASH) {
    console.warn('⚠️ WARNING: API_ID and/or API_HASH are not set. MTProto client cannot connect without them.');
    return null;
  }

  clientInitPromise = (async () => {
    try {
      console.log('🔄 Initializing Telegram MTProto Client with Bot Token...');
      const session = new StringSession(process.env.SESSION_STRING || '');
      client = new TelegramClient(session, API_ID, API_HASH, {
        connectionRetries: 10,
        autoReconnect: true,
        useWSS: false
      });

      await client.start({
        botAuthToken: BOT_TOKEN
      });

      console.log('✅ Telegram MTProto Client connected successfully as bot!');
      clientReady = true;
      return client;
    } catch (err) {
      console.error('❌ Failed to connect Telegram MTProto Client:', err.message);
      clientReady = false;
      clientInitPromise = null;
      return null;
    }
  })();

  return clientInitPromise;
}

// Immediately trigger connection if credentials are provided
if (API_ID && API_HASH) {
  getTelegramClient().catch(console.error);
}

// ==============================================================================
// 1. HEALTH CHECK & STATUS ROUTE (For Render Keep-Alive / Uptime Monitoring)
// ==============================================================================
app.get(['/', '/health'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'xmi-stream-bot',
    bot_ready: clientReady,
    mtproto_configured: Boolean(API_ID && API_HASH),
    timestamp: new Date().toISOString()
  });
});

// HEAD requests for fast verification
app.head(['/', '/health', '/stream*'], (req, res) => {
  res.status(200).end();
});

// ==============================================================================
// 2. HELPER: Extract Media Document / Video from Message
// ==============================================================================
function getMediaDetails(message) {
  if (!message || !message.media) return null;

  const doc = message.media.document;
  if (doc) {
    let fileName = 'video.mp4';
    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr.fileName) {
          fileName = attr.fileName;
          break;
        }
      }
    }
    return {
      media: message.media,
      size: Number(doc.size),
      mimeType: doc.mimeType || 'video/mp4',
      fileName
    };
  }

  const video = message.media.video;
  if (video) {
    return {
      media: message.media,
      size: Number(video.size),
      mimeType: 'video/mp4',
      fileName: 'video.mp4'
    };
  }

  return null;
}

// ==============================================================================
// 3. FILE INFO ROUTE: Query metadata without streaming
// ==============================================================================
app.get('/info/:channelId/:messageId', async (req, res) => {
  try {
    const tgClient = await getTelegramClient();
    if (!tgClient) {
      return res.status(503).json({ error: 'Telegram MTProto client is not configured with API_ID and API_HASH.' });
    }

    let channelId = req.params.channelId;
    if (channelId.startsWith('-100')) {
      channelId = channelId.slice(4);
    }
    const messageId = Number(req.params.messageId);

    const messages = await tgClient.getMessages(channelId, { ids: [messageId] });
    const message = messages && messages[0];
    const media = getMediaDetails(message);

    if (!media) {
      return res.status(404).json({ error: 'Media not found in the specified channel message.' });
    }

    return res.status(200).json({
      success: true,
      file_name: media.fileName,
      size: media.size,
      mime_type: media.mimeType
    });
  } catch (err) {
    console.error('Info query error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ==============================================================================
// 4. MAIN STREAMING ROUTE: Channel Message Streaming with HTTP Range Support
// Supports both:
//   /stream/:channelId/:messageId
//   /stream?channel_id=...&msg_id=...
// ==============================================================================
app.get(['/stream/:channelId/:messageId', '/stream'], async (req, res) => {
  try {
    let rawChannelId = req.params.channelId || req.query.channel_id || DEFAULT_CHANNEL_ID;
    let messageId = Number(req.params.messageId || req.query.msg_id || req.query.message_id);

    if (!messageId) {
      return res.status(400).json({ error: 'Missing message ID (msg_id).' });
    }

    // Convert -100xxxx to positive entity id if needed by GramJS
    let channelTarget = rawChannelId;
    if (typeof channelTarget === 'string' && channelTarget.startsWith('-100')) {
      channelTarget = Number(channelTarget);
    }

    const tgClient = await getTelegramClient();
    if (!tgClient) {
      return res.status(503).json({
        error: 'Telegram MTProto client is initializing or missing API_ID/API_HASH.',
        instructions: 'Add API_ID and API_HASH to Render environment variables.'
      });
    }

    // Retrieve message from storage channel with memory caching to avoid MTProto RPC lag on every chunk
    const cacheKey = `${channelTarget}:${messageId}`;
    let media = null;
    const cachedMedia = mediaCache.get(cacheKey);
    if (cachedMedia && (Date.now() - cachedMedia.timestamp < 3600000)) {
      media = cachedMedia;
    } else {
      const messages = await tgClient.getMessages(channelTarget, { ids: [messageId] });
      const message = messages && messages[0];
      const details = getMediaDetails(message);
      if (details) {
        media = { ...details, timestamp: Date.now() };
        mediaCache.set(cacheKey, media);
      }
    }

    if (!media) {
      return res.status(404).json({ error: 'Media not found in specified message.' });
    }

    const fileSize = media.size;
    const mimeType = media.mimeType || 'video/mp4';
    const range = req.headers.range;

    // Handle Client Abort (user closed video player or scrolled away)
    let isAborted = false;
    req.on('close', () => {
      isAborted = true;
    });

    if (range) {
      // Parse Range Header (e.g. "bytes=1048576-2097151" or "bytes=1048576-")
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize) {
        res.status(416).set({
          'Content-Range': `bytes */${fileSize}`
        }).end();
        return;
      }

      // Fast, responsive chunk size (1MB max chunk) so video frames arrive quickly
      // and mobile browser network timeouts are avoided on any connection speed
      const MAX_CHUNK = 1024 * 1024;
      if (end - start + 1 > MAX_CHUNK) {
        end = Math.min(start + MAX_CHUNK - 1, fileSize - 1);
      }

      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Content-Disposition': 'inline',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });

      // Stream chunks via GramJS with 512KB MTProto block size for faster throughput
      let bytesSent = 0;
      for await (const chunk of tgClient.iterDownload({
        file: media.media,
        offset: bigInt(start),
        requestSize: 512 * 1024
      })) {
        if (isAborted) break;
        const remaining = chunkSize - bytesSent;
        if (remaining <= 0) break;
        if (chunk.length > remaining) {
          res.write(chunk.subarray(0, remaining));
          bytesSent += remaining;
          break;
        } else {
          res.write(chunk);
          bytesSent += chunk.length;
        }
      }
      res.end();
    } else {
      // No Range header provided: stream full file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
        'Content-Disposition': 'inline',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });

      for await (const chunk of tgClient.iterDownload({
        file: media.media,
        offset: bigInt(0),
        requestSize: 512 * 1024
      })) {
        if (isAborted) break;
        res.write(chunk);
      }
      res.end();
    }
  } catch (err) {
    console.error('Streaming error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Stream processing failed' });
    } else {
      res.end();
    }
  }
});

// ==============================================================================
// 5. BOT API PROXY ROUTE: Stream files using Bot API (<20MB)
// Useful for instant playback of files uploaded via standard bot file_id
// ==============================================================================
app.get('/file/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    if (!fileId) return res.status(400).send('Missing file_id');

    // Fetch file path from Telegram Bot API
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const tgData = await tgRes.json();

    if (!tgData.ok || !tgData.result?.file_path) {
      return res.status(404).json({ error: 'File not found or expired', details: tgData });
    }

    const filePath = tgData.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const fileStreamRes = await fetch(downloadUrl, { headers });
    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Type': fileStreamRes.headers.get('content-type') || 'video/mp4'
    };

    if (fileStreamRes.headers.get('content-range')) {
      responseHeaders['Content-Range'] = fileStreamRes.headers.get('content-range');
    }
    if (fileStreamRes.headers.get('content-length')) {
      responseHeaders['Content-Length'] = fileStreamRes.headers.get('content-length');
    }

    res.writeHead(fileStreamRes.status, responseHeaders);

    const reader = fileStreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('File stream error:', err);
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`🚀 XMI Stream Server listening on port ${PORT}`);
  console.log(`🤖 Stream Bot Token: ${BOT_TOKEN.slice(0, 10)}...`);
  console.log(`📡 Storage Channel: ${DEFAULT_CHANNEL_ID}`);
  console.log(`=================================================`);
});
