# 🎥 XMI Telegram Video Streaming Server

High-performance MTProto & HTTP Range Video Streaming Server for Telegram Mini Apps and browsers.

Built specifically to stream videos from private Telegram storage channels directly into your Telegram Mini App with smooth timeline scrubbing (HTTP 206 Partial Content).

---

## 🚀 Features

- **HTTP Range Requests (RFC 7233)**: Supports seeking, forward/rewind, and instant playback without downloading entire files.
- **Telegram MTProto (GramJS)**: Direct connection to Telegram's Data Centers — bypasses the official Bot API 20MB download limit (streams up to 2GB files!).
- **Free Tier Optimized**: Runs smoothly on Render's free tier with minimal memory footprint (< 100MB RAM).
- **CORS Enabled**: Ready to stream into Telegram Mini App WebViews, iOS, Android, and desktop browsers.
- **Health Check & Keep-Alive**: Built-in `/health` endpoint for uptime monitoring and spin-down prevention.

---

## 🛠️ Step-by-Step Render Deployment Guide

### Step 1: Add Bot as Channel Administrator
Make sure your streaming bot (`@Xmi_stream_bot` / `8636298353:...`) is added as an **Administrator** to your Telegram Storage Channel (`-1004415998750`) with permission to read messages.

### Step 2: Get Telegram API ID & API Hash (Free)
1. Go to [https://my.telegram.org](https://my.telegram.org) and log in with your Telegram phone number.
2. Click **API development tools**.
3. Fill in any name for App title (e.g. `Xmi Streamer`) and short name.
4. Copy your **`api_id`** (numeric) and **`api_hash`** (alphanumeric string).

### Step 3: Deploy on Render Free Tier
1. Open [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** -> **Web Service**.
3. Select **Build and deploy from a Git repository**.
4. Connect and choose: `https://github.com/smile067cm-commits/xmi-stream-bot`.
5. Settings:
   - **Name**: `xmi-stream-bot`
   - **Region**: Any (e.g. Oregon or Frankfurt)
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
6. In **Environment Variables**, add:
   - `BOT_TOKEN`: `8636298353:AAG51fEmR_gKaj8kZ09NV_p-833RJfE5dPU`
   - `CHANNEL_ID`: `-1004415998750`
   - `API_ID`: *your api_id from Step 2*
   - `API_HASH`: *your api_hash from Step 2*
7. Click **Create Web Service**!

Render will build and give you a live URL like:
`https://xmi-stream-bot.onrender.com`

---

## 📡 API Endpoints

### 1. Health Check
```http
GET /health
```
Returns 200 OK with server status and readiness.

### 2. Stream Video by Channel Message ID
```http
GET /stream/:channelId/:messageId
```
or
```http
GET /stream?channel_id=-1004415998750&msg_id=123
```
Streams the video directly to HTML5 `<video>` player with Range requests.

### 3. Media Metadata
```http
GET /info/:channelId/:messageId
```
Returns file name, size, and mime type.
