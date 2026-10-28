# Step-by-step setup guide

This guide takes you from nothing to Claude using all your Google accounts. You don't need to know anything about Google Cloud or programming. Every step says exactly what to click.

**Time:** about 30 minutes. **Cost:** about $0 a month for one person.

[← Back to the README](../README.md)

> 🤖 **Have Claude Code or another AI agent?** It can do most of these steps for you. See [Let your AI agent set it up](../README.md#let-your-ai-agent-set-it-up).

---

## Contents

1. [A few words first](#1-a-few-words-first)
2. [Create a Google Cloud account](#2-create-a-google-cloud-account)
3. [Create a project](#3-create-a-project)
4. [Open Cloud Shell](#4-open-cloud-shell)
5. [Get the code and enter your details](#5-get-the-code-and-enter-your-details)
6. [First run of the setup script](#6-first-run-of-the-setup-script)
7. [Set up Google sign-in](#7-set-up-google-sign-in)
8. [Deploy the hub](#8-deploy-the-hub)
9. [Connect your Google accounts](#9-connect-your-google-accounts)
10. [Connect Claude](#10-connect-claude)
11. [Try it](#11-try-it)
12. [Keeping it tidy](#12-keeping-it-tidy)
13. [If something goes wrong](#13-if-something-goes-wrong)

---

## 1. A few words first

You'll meet these words along the way:

| Word | Plain meaning |
| --- | --- |
| **Google Cloud** | Google's service for running programs on its computers. The hub runs there |
| **Project** | A folder in Google Cloud that holds everything for one app |
| **Billing account** | The card Google Cloud charges. Needed even when usage is free |
| **Cloud Shell** | A command window that opens in your browser. Nothing to install |
| **Cloud Run** | The part of Google Cloud that runs the hub, only when it's used |
| **OAuth client** | Your app's "Sign in with Google" identity. You create it once |
| **Connector** | How Claude plugs into outside tools such as this hub |
| **MCP** | Model Context Protocol, the standard Claude uses to talk to connectors |

**How it fits together:** you ask Claude something. Claude asks your hub. Your hub, running in your own Google Cloud project, asks Gmail, Drive or Calendar for the right account and hands the answer back.

> 💡 **Copying commands:** grey boxes like the one below are commands. Hover over one and click the copy icon, then paste into Cloud Shell with **Ctrl+V** (or **Cmd+V** on a Mac) and press **Enter**.
>
> ```sh
> echo "hello"
> ```

---

## 2. Create a Google Cloud account

Skip this if you already use Google Cloud.

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)** and sign in with your Google account.
2. Accept the terms of service if asked.
3. Click **Activate** or **Start free** at the top, if shown. New accounts get free trial credit.
4. Enter your country, then a card. You won't be charged unless you go beyond the free amounts, which one person using this hub won't.

> 🔒 **Why a card?** Google requires one for Cloud accounts to prevent abuse. In [step 12](#12-keeping-it-tidy) you'll set an alert that emails you if anything starts costing money.

---

## 3. Create a project

1. Open **[console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)**.
2. **Project name:** type something like `My MCP Hub`.
3. Under the name, Google shows a **Project ID**. Click **Edit** and choose a short ID you'll remember, like `my-mcp-hub-2026`.
   - ⚠️ The ID **cannot contain the word "google"**. Google rejects it.
   - The ID can't be changed later.
4. **Location:** leave it as **No organization** unless you know you need otherwise.
5. Click **Create**. Wait a few seconds.
6. Make sure billing is on: open **[console.cloud.google.com/billing/linkedaccount](https://console.cloud.google.com/billing/linkedaccount)**, pick your new project at the top, and link your billing account if it says billing is disabled.

📝 **Write down your Project ID.** You'll need it in step 5.

<details>
<summary>"You have exceeded your project quota"</summary>

Personal accounts can only have a few projects. Either:

- delete a project you no longer use (it still counts for 30 days), or
- reuse an existing project. The hub only adds its own items, all named `hub-…` or `google-mcp-hub`, or
- [ask Google for more projects](https://support.google.com/code/contact/project_quota_increase).

</details>

---

## 4. Open Cloud Shell

1. Open **[shell.cloud.google.com](https://shell.cloud.google.com)**. A black command window opens, either in the browser tab or along the bottom of the page.
2. Tell it which project to use. Replace `my-mcp-hub-2026` with your Project ID:

```sh
gcloud config set project my-mcp-hub-2026
```

3. If a window asks you to **Authorize Cloud Shell**, click **Authorize**.

---

## 5. Get the code and enter your details

1. Download the code and go into its folder:

```sh
git clone https://github.com/rescueahero4/google-mcp-hub.git
cd google-mcp-hub
cp deploy.env.example deploy.env
```

2. Open the settings file in a simple text editor:

```sh
nano deploy.env
```

3. Use the arrow keys to move, and change these three lines:

| Line | What to put |
| --- | --- |
| `PROJECT_ID=` | Your Project ID from step 3 |
| `REGION=` | A place near you (see the table below) |
| `OWNER_EMAILS=` | The Google email you'll use to sign in to the hub. Only this account will be allowed in |

Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty for now.

| You live in | Use |
| --- | --- |
| United States | `us-central1` |
| Europe | `europe-west1` |
| United Kingdom | `europe-west2` |
| Japan | `asia-northeast1` |
| Singapore / Southeast Asia | `asia-southeast1` |
| Australia | `australia-southeast1` |

4. Save and close: press **Ctrl+O**, then **Enter**, then **Ctrl+X**.

> 🔒 `deploy.env` stays in your Cloud Shell. It is never uploaded anywhere public.

---

## 6. First run of the setup script

```sh
./scripts/deploy.sh
```

1. It shows your account, project and region, then asks **"Deploy with these settings? [y/N]"**. Check them, type `y` and press **Enter**.
2. It turns on the Google services the hub needs. This takes a minute or two.
3. Then it stops and prints a box of instructions, including a line like:

```
https://google-mcp-hub-123456789.us-central1.run.app/oauth/google/callback
```

📝 **Copy that address.** It's your **redirect URI**, and you'll paste it in the next step. Keep Cloud Shell open.

---

## 7. Set up Google sign-in

The hub needs its own "Sign in with Google" identity. Google doesn't let scripts create it, so this is the one part you click through yourself.

### 7a. Describe your app

1. Open **[console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview)**. Check your project is selected at the top.
2. Click **Get started**.
3. **App information:** App name `My MCP Hub`. Support email: your email. Click **Next**.
4. **Audience:** choose **External**. Click **Next**.
   - Use **Internal** only if your project belongs to a Google Workspace organization *and* every account you'll connect is in that organization.
5. **Contact information:** your email. Click **Next**.
6. Tick the box to agree to the policy, then click **Continue** and **Create**.

### 7b. Keep connected accounts from expiring

1. In the left menu, click **Audience**.
2. Under **Publishing status**, click **Publish app**, then **Confirm**.

> 🔒 **This does not make anything public.** Your hub isn't listed anywhere, and only the email in `OWNER_EMAILS` can use it. Publishing only stops Google from disconnecting your accounts every 7 days. [More detail](../README.md#testing-vs-in-production).

### 7c. Create the sign-in client

1. In the left menu, click **Clients**, then **Create client**.
2. **Application type:** **Web application**.
3. **Name:** `MCP Hub`.
4. Under **Authorized redirect URIs**, click **Add URI** and paste the address from step 6.
5. Click **Create**.
6. A window shows your **Client ID** and **Client secret**. Copy both somewhere safe for a minute.
   - ⚠️ Google may show the secret only once. If you lose it, open the client and add a new secret.

### 7d. Put them in your settings

Back in Cloud Shell:

```sh
nano deploy.env
```

Fill in the two lines, then save and close (**Ctrl+O**, **Enter**, **Ctrl+X**):

```ini
GOOGLE_CLIENT_ID=paste-your-client-id-here
GOOGLE_CLIENT_SECRET=paste-your-client-secret-here
```

> 🔒 Never share your client secret or post it online.

---

## 8. Deploy the hub

```sh
./scripts/deploy.sh
```

1. Type `y` when asked.
2. Wait 3–5 minutes. Most of it is "Building Container…".
3. When it finishes, it prints:

```
Hub:              https://google-mcp-hub-123456789.us-central1.run.app/
Claude connector: https://google-mcp-hub-123456789.us-central1.run.app/mcp
```

📝 **Save both addresses.** The first is your hub's page. The second is what you give Claude.

<details>
<summary>It failed. What now?</summary>

Run the same command again. The script is safe to repeat: it skips what's already done and fixes what's missing. If it fails the same way twice, see [If something goes wrong](#13-if-something-goes-wrong).

</details>

---

## 9. Connect your Google accounts

1. Open the **Hub** address in your browser.
2. Sign in with the Google account you put in `OWNER_EMAILS`.
3. Under **Connect an account**:
   - **Name** (optional): a short nickname like `personal`. Leave it empty to use the part of the email before `@`.
   - **Tags** (optional): groups like `work` or `family`. Several accounts can share a tag.
   - **Access:** `read-write` lets Claude create drafts, files and events. `read-only` only lets it read.
4. Click **Connect with Google**.
5. Pick the account to connect. If it isn't listed, click **Use another account**.
6. Google says **"Google hasn't verified this app"**. That's expected: it's your own app, and Google only verifies apps used by the public. Click **Advanced**, then **Go to My MCP Hub (unsafe)**.
7. Click **Continue** to allow access. You're back on the hub page with the account listed.

Repeat for every account you want Claude to use.

> 💡 You can change names and tags any time in the table, then press **Save**. **Reconnect** refreshes an account. **Disconnect** removes it and revokes its access at Google.

---

## 10. Connect Claude

### claude.ai, Claude Desktop and mobile

1. Open **[claude.ai](https://claude.ai)** → your name or initials → **Settings** → **Connectors**.
2. Click **Add custom connector**.
3. **Name:** `Google MCP Hub`. **URL:** your **Claude connector** address (the one ending in `/mcp`).
4. Click **Add**, then **Connect**.
5. Sign in with your owner Google account.
6. The hub shows **"Allow Claude to use this hub?"**. Click **Approve**.

The connector now also works in the Claude Desktop and mobile apps signed in to the same account.

> 💡 On Team or Enterprise plans, an owner may need to add the connector for you.

### Claude Code

```sh
claude mcp add --transport http google-hub https://your-hub-address/mcp
```

Then type `/mcp` inside Claude Code, choose `google-hub`, and sign in and approve the same way.

---

## 11. Try it

Start a new chat. Make sure the connector is switched on in the chat's tools menu, then try:

- *"List my connected Google accounts."*
- *"Show the 3 latest emails in each account."*
- *"What's on my calendars this week?"*
- *"Find a free hour on Thursday afternoon across all my accounts."*
- *"Find the latest invoice in my work email and save a summary as a Google Doc in my personal Drive."*

The first request after a quiet spell can take a few seconds while the hub wakes up.

---

## 12. Keeping it tidy

**Set a budget alert.** This emails you if costs ever go above an amount you choose.

1. Open **[console.cloud.google.com/billing/budgets](https://console.cloud.google.com/billing/budgets)**.
2. Click **Create budget**, name it, pick your project, set the amount to `5`, and keep the default alerts.
3. Click **Finish**.

**Update to a new version** (in Cloud Shell):

```sh
cd google-mcp-hub
git pull
./scripts/deploy.sh --yes
```

**Sign every Claude app out** (if you think a device was lost):

```sh
./scripts/deploy.sh --yes --rotate-signing-key
```

**Remove everything:** disconnect your accounts on the hub page first, then delete the project:

```sh
gcloud projects delete my-mcp-hub-2026
```

---

## 13. If something goes wrong

| What you see | What to do |
| --- | --- |
| Project ID is rejected | Don't use the word "google" in the ID |
| "Exceeded your project quota" | See the tip in [step 3](#3-create-a-project) |
| `redirect_uri_mismatch` when signing in | The redirect URI in [step 7c](#7c-create-the-sign-in-client) must match the script's exactly, with no extra spaces or a trailing `/` |
| "Google hasn't verified this app" | Normal. **Advanced → Go to … (unsafe)** |
| "This hub is private" | You signed in with an email that isn't in `OWNER_EMAILS`. Use that account, or add the email to `deploy.env` and run the script again |
| Accounts stop working after a week | Your app is still in Testing. Do [step 7b](#7b-keep-connected-accounts-from-expiring) |
| A work account can't connect | Your company's Google admin blocks outside apps. Ask them to allow your client ID |
| Claude says the connector failed | Remove and re-add it in Claude's settings, then sign in and **Approve** again |
| Claude doesn't see a new tool after an update | Start a new chat, or switch the connector off and on |
| Anything else | Open **Cloud Run** in the Console → `google-mcp-hub` → **Logs**. Look for red lines |

More answers are in the [README's troubleshooting section](../README.md#reference).

[← Back to the README](../README.md)
