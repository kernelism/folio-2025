# Portfolio Setup Guide

## Environment Variables Setup for Vercel

### Step 1: Get Your Web3Forms Access Key
1. Go to [web3forms.com](https://web3forms.com)
2. Sign up for a free account
3. Create a new form and get your access key

### Step 2: Add Environment Variable to Vercel

#### Option A: Using Vercel Dashboard (Recommended)
1. Go to your project on [vercel.com](https://vercel.com)
2. Go to **Settings** → **Environment Variables**
3. Add a new environment variable:
   - **Key**: `WEB3FORMS_ACCESS_KEY`
   - **Value**: Your Web3Forms access key
   - **Environment**: Select all (Production, Preview, Development)
4. Click **Save**
5. Redeploy your site

#### Option B: Using Vercel CLI
```bash
vercel env add WEB3FORMS_ACCESS_KEY
```
Then paste your access key when prompted.

### Step 3: Deploy
```bash
# Install Vercel CLI (if not already installed)
npm i -g vercel

# Deploy to Vercel
vercel
```

### Local Development

For local testing, create a `.env` file in the root directory:

```bash
# Copy the example file
cp env.example .env

# Edit .env and add your actual key
WEB3FORMS_ACCESS_KEY=your_actual_key_here
```

Then run:
```bash
vercel dev
```

This will start a local development server with serverless functions enabled.

## How It Works

1. The contact form (`index.html`) sends data to `/api/contact`
2. The serverless function (`api/contact.js`) receives the request
3. It reads the access key from the environment variable `WEB3FORMS_ACCESS_KEY`
4. It forwards the request to Web3Forms API
5. Returns the response to the client

**Your access key is never exposed to the client!** ✅

## File Structure
```
portfolio/
├── api/
│   └── contact.js          # Serverless function (keeps key secure)
├── index.html              # Main site
├── content.json            # Site content
├── styles.css              # Styles
├── vercel.json             # Vercel configuration
├── .gitignore              # Git ignore (includes .env)
└── env.example             # Example environment variables
```

## Security Notes

- ✅ Never commit `.env` files to Git (already in `.gitignore`)
- ✅ Access key stays on the server (serverless function)
- ✅ Client only sends form data, never the access key
- ✅ Environment variables are encrypted in Vercel

