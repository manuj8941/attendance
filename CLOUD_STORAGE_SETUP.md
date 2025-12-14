# Cloud Storage Migration Complete! ☁️

## What Changed

Your attendance app now supports **dual-mode storage**:
- **Local Development**: Uses local SQLite (`attendance.db`) + filesystem (`./selfies/`, `./logos/`)
- **Production (Render)**: Uses Turso (cloud SQLite) + Cloudflare R2 (cloud storage)

## How It Works

The app automatically detects which mode to use based on environment variables:

### Local Mode (Development)
- If `TURSO_DATABASE_URL` is empty → Uses local SQLite
- If `R2_ACCOUNT_ID` is empty → Uses local filesystem
- Console shows: `💾 Connected to local SQLite database` and `📁 Using local filesystem`

### Cloud Mode (Production)
- If Turso/R2 credentials are set → Uses cloud storage
- Console shows: `☁️  Using Turso database` and `📦 Using Cloudflare R2`

## Setup Instructions

### 1. Local Development (No Changes Needed)
Your `.env` file should keep these empty:
```bash
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=
```

Run locally as usual:
```bash
node index.js
```

### 2. Production Deployment on Render

Set these environment variables in Render dashboard:

```bash
# Turso Database
TURSO_DATABASE_URL=libsql://attendance-db-manuj8941.aws-ap-south-1.turso.io
TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NjU3NDk3MjMsImlkIjoiNGI5OTgxMzgtNTA0My00OTJmLWFmODItOWQ4OGIyOTdjMDRjIiwicmlkIjoiMjliOWE5NDEtMGE2My00Yzg2LThjNGItOTg1MzQ3OTMwYjMxIn0.otp4gnO0hDyNE_4iT698L4Pbu0FLqlhU0C3jVqoG5DPVu16KpNG-Z94G8Sw4Uc4UiZObChLHLk5mGuuNoXgcAQ

# Cloudflare R2
R2_ACCOUNT_ID=524893e148065af599d803dd1981d833
R2_ACCESS_KEY_ID=vvXu_Gg9m3g4RnWZTE8G_9w_mQtRY3M-mSCTu-R1
R2_SECRET_ACCESS_KEY=8afeab211d364090e0ac3f4e9c417d604bd09a9bcb912089ba31a8175b236a6c
R2_BUCKET_NAME=attendance-selfies
R2_PUBLIC_URL=https://524893e148065af599d803dd1981d833.r2.cloudflarestorage.com

# Your existing vars (keep these too)
SESSION_SECRET=your-secret-here
SEED_USERS=smita:111:owner:2025-12-01,dinesh:111:manager:2025-12-01,...
```

## Files Modified

### New Files Created:
- `db/connection.js` - Database abstraction (SQLite ↔ Turso)
- `db/storage.js` - File storage abstraction (Filesystem ↔ R2)

### Updated Files:
- `package.json` - Added `@libsql/client` and `@aws-sdk/client-s3`
- `.env.example` - Added cloud storage configuration template
- `index.js` - Updated to use storage abstractions
- `db/database.js` - Uses new connection module

## Testing

### Test Locally:
```bash
# Should use local storage
node index.js
```
Check console for: `💾 Connected to local SQLite` and `📁 Using local filesystem`

### Test with Cloud (Optional Before Deploy):
1. Copy your `.env` file to `.env.cloud`
2. Add the Turso and R2 credentials to `.env.cloud`
3. Run: `node index.js`
4. Check console for: `☁️  Using Turso database` and `📦 Using Cloudflare R2`
5. Upload a logo and selfie to verify R2 works

## Benefits

✅ **No more data loss on Render** - DB and files persist across restarts
✅ **Free hosting** - Turso and R2 free tiers are generous
✅ **Same code everywhere** - Auto-detects environment
✅ **Fast development** - Local SQLite for quick testing
✅ **Global CDN** - R2 delivers selfies/logos quickly worldwide

## Troubleshooting

**If app won't start on Render:**
- Check environment variables are set correctly
- View Render logs for error messages
- Verify Turso database is accessible
- Confirm R2 bucket exists and permissions are correct

**If selfies won't upload:**
- Check R2 API token has Read & Write permissions
- Verify bucket name matches exactly
- Check file size is under 5MB

**If logo appears broken:**
- Ensure R2_PUBLIC_URL is correct
- Check logo was uploaded successfully to R2
- Try re-uploading the logo

## Next Steps

1. Deploy to Render with the new environment variables
2. Upload a test logo to verify R2 works
3. Have an employee mark attendance to test selfie upload
4. Check Turso dashboard to see your data

Your app is now production-ready with persistent cloud storage! 🎉
