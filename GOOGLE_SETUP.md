# Google Sign-In Setup Guide
## CT React — One-Time Configuration

This only needs to be done once by whoever manages the Google Workspace / GCP account.
After setup, every team lead just clicks "Sign in with Google" — no tokens, no passwords.

---

## Step 1 — Create a Google Cloud Project

1. Go to **console.cloud.google.com**
2. Click the project dropdown → **New Project**
3. Name it `CT React` → Create
4. Make sure this project is selected for all steps below

**Enable these APIs** (APIs & Services → Library → search each):
- Gmail API
- Google Search Console API
- Google Analytics Data API
- Google Analytics Admin API

---

## Step 2 — Create OAuth2 Client ID (for the Sign-In button)

1. APIs & Services → **Credentials** → Create Credentials → **OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Name: `CT React`
4. Authorized JavaScript origins:
   - `http://localhost:5173` (for local dev)
   - `https://ct-react.netlify.app` (your production URL)
5. Click Create → copy the **Client ID** (looks like `123456.apps.googleusercontent.com`)
6. Add to your Railway server env: `GOOGLE_CLIENT_ID=...`
7. Add to your frontend `index.html`:
   ```html
   <script>
     window.CT_API_URL = "https://ct-react-backend.up.railway.app";
     window.CT_GOOGLE_CLIENT_ID = "123456.apps.googleusercontent.com";
   </script>
   ```

---

## Step 3 — Create a Service Account (for all API calls)

1. APIs & Services → **Credentials** → Create Credentials → **Service Account**
2. Name: `ct-react-service` → Create and Continue → Done
3. Click the service account → **Keys** tab → Add Key → **JSON** → download the file
4. Open the JSON file, copy the entire contents, paste as a single line into Railway:
   ```
   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":...}
   ```
   > Tip: `cat key.json | tr -d '\n'` gives you a single-line version

---

## Step 4 — Grant the service account access to GSC and GA4

The service account has an email like `ct-react-service@your-project.iam.gserviceaccount.com`.
You need to add it as a viewer in every property you want to track.

**Google Search Console:**
1. search.google.com/search-console → select a property → Settings → Users and permissions
2. Add user → paste the service account email → Permission: **Full** → Add

**Google Analytics 4:**
1. analytics.google.com → Admin → Account or Property → Account Access Management
2. Add users → paste the service account email → Role: **Viewer** → Add

Repeat for each client property you want to track.

---

## Step 5 — Enable Domain-Wide Delegation (for Gmail)

This lets the service account read Gmail on behalf of any `@coalitiontechnologies.com` user.

1. In Google Cloud Console, click the service account → **Details** tab
2. Check **"Enable G Suite Domain-wide Delegation"** → Save
3. Note the **Client ID** of the service account (different from the OAuth client ID)
4. Go to **admin.google.com** (Google Workspace Admin)
5. Security → API Controls → **Domain-wide Delegation** → Add new
6. Client ID: paste the service account's client ID
7. OAuth scopes (paste all three, comma-separated):
   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/analytics.readonly
   ```
8. Authorize

---

## Step 6 — Set all Railway environment variables

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From Step 2 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | From Step 3 (single-line JSON) |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `DATABASE_URL` | Auto-set by Railway Postgres plugin |
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `ALLOWED_ORIGIN` | Your Netlify URL |
| `ALLOWED_DOMAIN` | `coalitiontechnologies.com` |

---

## Step 7 — Add Postgres to Railway

1. In your Railway project → **New** → **Database** → **PostgreSQL**
2. Railway automatically sets `DATABASE_URL` — nothing else to do
3. The server creates the tables on first start

---

## That's it

Once deployed, team leads visit the URL, click **Sign in with Google**, and are in.
No tokens to copy, no credentials to share, no expiry to manage.

The service account's credentials never leave your Railway server.
