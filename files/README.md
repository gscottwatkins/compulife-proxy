# Compulife API Proxy — Railway (Static IP)

Replaces the Netlify serverless function to solve the rotating IP problem.
Railway's Static Egress IP add-on gives you a **fixed outbound IP** that Compulife can whitelist permanently.

## Deploy to Railway (10 minutes)

### Step 1: Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub

### Step 2: Create New Project
1. Click **"New Project"**
2. Choose **"Deploy from GitHub repo"** (push this code to a GitHub repo first)
   — OR choose **"Empty Project"** → **"Add Service"** → **"GitHub Repo"**

### Step 3: Enable Static Egress IP
**This is the critical step — it's why we're on Railway.**
1. Go to your service → **Settings** tab
2. Scroll to **"Networking"**
3. Click **"Enable TCP Proxy"** if needed
4. Click **"Enable Static Egress IP"** (may require paid plan ~$5/mo)
5. **Copy the static IP address shown** — this is what you give Compulife

### Step 4: Set Environment Variable
1. Go to **Variables** tab
2. Add: `COMPULIFE_AUTH_ID` = `6c1B02Df8`
   (Optional — it's hardcoded as fallback, but env var is cleaner)

### Step 5: Deploy
Railway auto-deploys on push. Check the deploy logs for:
```
✅ Compulife Proxy running on port 3000
   Auth ID: 6c1B...
```

### Step 6: Get Your Public URL
1. Go to **Settings** → **Networking** → **Public Networking**
2. Click **"Generate Domain"**
3. You'll get something like: `compulife-proxy-production-xxxx.up.railway.app`

### Step 7: Update Compulife IP Whitelist
Email/call Compulife with the **static egress IP** from Step 3.
Tell them to replace the old IP (18.117.165.168) with the new Railway static IP.

### Step 8: Update QuoteIt Engine
In your `index.html`, change the proxy URL from:
```
https://quoteitengine.com/.netlify/functions/compulife-proxy
```
to:
```
https://compulife-proxy-production-xxxx.up.railway.app
```

## API Reference

Same interface as the Netlify version. POST JSON to the root `/`:

```json
// Health check
{ "action": "ping" }

// Get rate quotes
{
  "action": "quote-compare",
  "State": "MS",
  "BirthMonth": "6",
  "Birthday": "15",
  "BirthYear": "1967",
  "Sex": "M",
  "Smoker": "N",
  "Health": "PP",
  "NewCategory": "5",
  "FaceAmount": "250000",
  "ModeUsed": "M"
}
```

## Custom Domain (Optional)
You can point `api.quoteitengine.com` to Railway:
1. In Railway Settings → Networking → Custom Domain
2. Add `api.quoteitengine.com`
3. Add the CNAME record to your DNS

## Cost
Railway Hobby Plan: ~$5/month (includes static egress IP)
Way cheaper than the headache of rotating Netlify IPs.
