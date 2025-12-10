# Attendance System Setup Guide

## Local Development Setup

### Prerequisites
- Node.js v16+ installed
- Git installed

### Initial Setup

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd attendance
npm install
```

2. **For HTTPS on local network (required for mobile camera/GPS):**

   **Using mkcert (Recommended):**
   ```bash
   # Install mkcert
   # Windows (using Chocolatey):
   choco install mkcert
   
   # Or download from: https://github.com/FiloSottile/mkcert/releases
   
   # Install local CA (one-time, creates trusted certificates)
   mkcert -install
   
   # Generate certificates for your local network
   # Replace 192.168.1.x with your actual local IP
   mkcert localhost 127.0.0.1 192.168.1.x
   
   # This creates two files:
   # - localhost+2-key.pem (private key)
   # - localhost+2.pem (certificate)
   
   # Move them to the project root - the app will auto-detect them
   ```

3. **Install certificate on mobile devices (for testing):**
   - On your computer, locate the mkcert root CA file:
     ```bash
     mkcert -CAROOT
     ```
   - Share the `rootCA.pem` file to your mobile device
   - **iOS:** Email it to yourself, tap to install (Settings > General > Profile)
   - **Android:** Settings > Security > Install from storage > Select the file

4. **Start the development server:**
```bash
npm start
# Or directly:
node index.js
```

The app will:
- Auto-detect certificate files (any .pem files with `-key` for private key)
- Start HTTPS if certs found, HTTP if not
- Display local IP address for mobile access
- Create `attendance.db` with seed users (password: "111" for all)

### Moving to Another Laptop

1. Clone the repository
2. Run `npm install`
3. Generate new certificates with mkcert (using your new local IP)
4. Start the server - it will auto-detect the new certificates

**No code changes needed!** The server automatically:
- Finds any `.pem` certificate files
- Detects your local IP address
- Displays correct access URLs

## Production Deployment (Render/Railway)

### Render Setup

1. **Create new Web Service** on Render dashboard
2. **Connect your GitHub repository**
3. **Configure:**
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Environment Variables:**
     - `NODE_ENV` = `production`
     - `SESSION_SECRET` = `<generate-random-string>`

4. **Deploy** - Render will:
   - Automatically provide HTTPS via load balancer
   - Use plain HTTP inside the container (secure!)
   - Assign a dynamic PORT

### Railway Setup

1. **New Project** > Deploy from GitHub
2. **Add Environment Variables:**
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = `<generate-random-string>`
3. **Deploy** - Railway handles HTTPS automatically

## Default Users

All users have password: **"111"**

- **smita** - Owner (full access)
- **dinesh** - Manager (approve leaves, view all attendance)
- **manuj, atul, kamini, nazmul** - Employees

## Features Requiring HTTPS

These features **only work over HTTPS** (browser security requirement):
- Camera access (selfie capture)
- Geolocation (GPS coordinates)

**Local development:** Use mkcert certificates
**Production:** Platform provides HTTPS automatically

## Troubleshooting

**"No certificates found" warning:**
- Normal for first run
- Generate certificates with mkcert if you need mobile testing
- Or continue with HTTP for desktop-only testing

**Mobile device shows certificate error:**
- Install the mkcert root CA on the mobile device (see step 3 above)
- Or regenerate certificates including your device's IP

**Port already in use:**
- Change port: `PORT=3001 node index.js`
- Or kill the process using port 3000

**Database issues:**
- Delete `attendance.db` to reset (loses all data)
- Restart server - fresh database with seed users will be created
