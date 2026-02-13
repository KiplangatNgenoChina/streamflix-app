# StreamFlix Android App — Build & Deploy Guide

This guide covers deploying the web app to Vercel and building the Android app (Play Store + sideload).

---

## Prerequisites

1. **Node.js** (v18+)
2. **Java 17** (for Android builds) — [Adoptium](https://adoptium.net/) or [Oracle](https://www.oracle.com/java/technologies/downloads/)
3. **Android Studio** (for SDK + signing) — [Download](https://developer.android.com/studio)
4. **GitHub** account (for Vercel deploy via repo)

---

## Step 1: Deploy Web App to Vercel (GitHub)

### 1.1 Push code to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

### 1.2 Connect repo to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in (use **Continue with GitHub**)
2. Click **Add New → Project**
3. **Import** your GitHub repo and authorize if prompted
4. Configure (Vercel usually auto-detects):
   - **Framework Preset:** Other
   - **Root Directory:** `.` (leave default)
   - **Build Command:** leave empty
   - **Output Directory:** leave empty
5. Click **Deploy**

Vercel will build and deploy. Each push to `main` will trigger a new deployment.

### 1.3 Set environment variables in Vercel

In **Project → Settings → Environment Variables**, add:

| Variable | Value | Required |
|----------|-------|----------|
| `TMDB_API_KEY` | Your TMDB API key from [themoviedb.org](https://www.themoviedb.org/settings/api) | Yes |
| `STREMTHRU_STREAM_BASE_URL` | Your StremThru addon URL (no `/manifest.json`) | Yes |
| `STREMTHRU_TOKEN` | Token for your wrap (if needed) | No |

Redeploy after adding env vars.

### 1.4 Note your Vercel URL

After the first deploy, Vercel assigns a URL (e.g. `https://your-repo-name-xyz.vercel.app`). Find it in the project dashboard or the deploy logs.

---

## Step 2: Configure Capacitor for Your Deployed URL

Edit `capacitor.config.json` and set your Vercel URL:

```json
{
  "server": {
    "url": "https://YOUR-ACTUAL-URL.vercel.app",
    "cleartext": false
  }
}
```

Replace `YOUR-ACTUAL-URL` with your real Vercel deployment URL (no trailing slash).

---

## Step 3: Build the Android App

### 3.1 Sync web assets and native project

```bash
npm run build
```

This runs `copy-web` and `cap sync`.

### 3.2 Open in Android Studio (optional)

```bash
npx cap open android
```

In Android Studio: **File → Sync Project with Gradle Files**.

### 3.3 Create a signing key (first time)

```bash
keytool -genkey -v -keystore streamflix-release.keystore -alias streamflix -keyalg RSA -keysize 2048 -validity 10000
```

Store the keystore and passwords securely.

### 3.4 Configure signing in Android

Create or edit `android/keystore.properties`:

```properties
storePassword=YOUR_KEYSTORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=streamflix
storeFile=../streamflix-release.keystore
```

In `android/app/build.gradle`, inside `android { ... }`, add before `buildTypes`:

```gradle
signingConfigs {
    release {
        if (project.hasProperty('keystore.properties')) {
            def keystoreProperties = new Properties()
            keystoreProperties.load(new FileInputStream(project.file("keystore.properties")))
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
        }
    }
}
```

And in `buildTypes { release { ... } }` add:

```gradle
signingConfig signingConfigs.release
```

### 3.5 Build APK (for sideload)

```bash
cd android && ./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/release/app-release.apk`

### 3.6 Build AAB (for Play Store)

```bash
cd android && ./gradlew bundleRelease
```

AAB output: `android/app/build/outputs/bundle/release/app-release.aab`

---

## Step 4: Distribution

### Sideload (APK)

1. Copy `app-release.apk` to the device
2. Enable **Install from unknown sources** (or **Install unknown apps** for your file manager)
3. Install the APK

### Play Store (AAB)

1. Create an app in [Google Play Console](https://play.google.com/console)
2. Upload `app-release.aab` to **Production** or **Internal testing**
3. Complete **Store listing**, **Content rating**, **Privacy policy URL**
4. Submit for review

---

## Updating the App

### Web / API changes (instant)

- Change code and deploy to Vercel
- No app update needed — users get changes on next launch

### StremThru / TMDB config changes

- Edit env vars in Vercel dashboard
- Redeploy
- No app update needed

### App binary update (new version)

- Bump `versionCode` and `versionName` in `android/app/build.gradle`
- Rebuild APK/AAB
- Distribute new build (Play Store or sideload)

---

## Auth0 (optional)

If you use Auth0 for admin:

1. In Auth0 Dashboard → Applications → Your App → Settings
2. Add to **Allowed Callback URLs**:
   - `https://YOUR-VERCEL-URL.vercel.app`
   - `streamflix://YOUR-AUTH0-DOMAIN/callback` (for native)
3. Add to **Allowed Logout URLs**: `https://YOUR-VERCEL-URL.vercel.app`

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Unable to locate Java Runtime" | Install Java 17 and ensure `JAVA_HOME` is set |
| Gradle sync fails | Open project in Android Studio and sync manually |
| White/blank screen in app | Check `capacitor.config.json` `server.url` is correct and reachable |
| API errors 503 | Set `STREMTHRU_STREAM_BASE_URL` and `TMDB_API_KEY` in Vercel |
| Build fails on Apple Silicon / M1 | Use `./gradlew` (no `gradlew.bat`) and ensure Java is ARM64 |

---

## Project structure

```
movie-stream-copy/
├── index.html, styles.css, script.js   # Web app
├── api/                                 # Vercel serverless
│   ├── tmdb.js
│   └── streams.js
├── www/                                 # Copied for Capacitor (fallback)
├── android/                             # Android native project
├── capacitor.config.json               # ← Update server.url here
├── vercel.json
└── package.json
```
