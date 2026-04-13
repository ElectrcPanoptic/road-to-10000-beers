# Road to 10,000 — The Ledger

A shared drinking tally for your WhatsApp group. You upload the chat export once and everyone sees the same live dashboard — leaderboards, cumulative charts, weekly-seasonal forecast, per-person heatmaps, hall of fame.

Built as a static React site. No backend, no database, no monthly bill. The WhatsApp export lives as a plain text file inside the repo; every time you want to refresh the numbers you replace the file and push. Vercel rebuilds in under a minute.

---

## What's in this folder

```
road-to-10k/
├── public/
│   └── chat.txt          ← the WhatsApp export (your friends see this one)
├── src/
│   ├── App.jsx           ← the dashboard (parser, transformers, charts)
│   └── main.jsx          ← React entry point
├── index.html
├── vite.config.js
├── package.json
├── .gitignore
└── README.md
```

Your real chat export is already bundled in `public/chat.txt`, so the site will work with real data the moment it's deployed.

---

## Getting it online — first time, no terminal needed (~10 min)

### Step 1 · Create a GitHub account (skip if you have one)

Go to https://github.com/signup and make an account. Free.

### Step 2 · Put the code on GitHub

1. Go to https://github.com/new
2. Repository name: `road-to-10k` (or whatever you like)
3. Leave it **Public** (you said public is fine)
4. **Don't** check "Add a README" — this folder already has one
5. Click **Create repository**
6. On the next page, click the link that says **"uploading an existing file"**
7. Open this `road-to-10k` folder on your computer
8. Select everything inside (NOT the folder itself — the files and subfolders inside it) and drag onto the GitHub page. Include the `public` and `src` subfolders.
9. Scroll down and click **Commit changes**

GitHub now has your code.

### Step 3 · Deploy to Vercel

1. Go to https://vercel.com/signup
2. Click **Continue with GitHub** — this links your GitHub account
3. Once signed in, click **Add New…** → **Project**
4. Find `road-to-10k` in the list and click **Import**
5. Leave every setting as the default. Vercel auto-detects that it's a Vite project.
6. Click **Deploy**
7. Wait ~60 seconds. You'll get a URL like `https://road-to-10k.vercel.app`

That's your site. Share the URL in the group chat. Done.

---

## Updating the data

Every time you want to refresh the dashboard with a new export:

1. In WhatsApp: open the group → tap the group name → **Export chat** → **Without media** → email/send it to yourself and save the `.txt` file
2. Go to your GitHub repo in the browser
3. Click into `public/` → click on `chat.txt`
4. Click the **trash icon** (top right) to delete it → **Commit changes**
5. Go back to the `public/` folder → click **Add file** → **Upload files**
6. Drag the new `.txt` file in, then **rename it to `chat.txt`** (important — the app looks for exactly this filename)
7. Click **Commit changes**

Vercel will automatically rebuild in ~30 seconds. Everyone sees the new numbers on the next page refresh.

**Simpler alternative:** if you prefer, you can click the pencil (edit) icon on the existing `chat.txt`, select all, delete, paste the new content, commit. Same result.

---

## Running locally (optional)

If you want to test changes before pushing:

```bash
npm install
npm run dev
```

Then visit http://localhost:5173. Vite hot-reloads on save.

---

## Customising

Everything lives in `src/App.jsx`. Landmarks near the top:

| Variable | Default | What it controls |
|----------|---------|------------------|
| `GROUP_TARGET` | `10000` | The target on the forecast chart |
| `PERSON_COLORS` | 8-colour palette | Per-person colours (cycled) |
| `DRINK_EMOJIS` | 🍺🍻🍷🥃🍸🍹🥂🍶 | Emoji fallback for casual entries |
| `MAX_CHECKPOINT_JUMP` | `1000` | Typo guard on numeric dedup anchoring |

The file is organised into labelled sections: `CONFIG`, `PARSER`, `EXTRACTOR`, `TRANSFORMERS`, `CHART COMPONENTS`, `APP`. To add a new chart: write a pure transformer that takes `events`, write a presentational component that takes its output as props, add a `useMemo` and a grid cell in the `App` component. No other file touches.

Title and favicon are in `index.html`.

---

## Notes on privacy

The deployed site is a public URL. Anyone who knows or guesses the URL can read the entire chat export (names, phone numbers for unsaved contacts, timestamps). This is the cost of the zero-backend approach — the file has to be served to browsers, and anything served to browsers is technically readable.

If you change your mind:

- **Vercel password protection** — in your Vercel project dashboard, **Settings** → **Deployment Protection** → enable password. Takes 30 seconds. Note the free tier only allows one password for the whole project.
- **Make the GitHub repo private** — this hides the source code but doesn't hide the deployed site (Vercel still serves it). Combine with password protection for real privacy.
- **Strip phone numbers** — you could add a step where you manually redact unsaved contacts in `chat.txt` before committing. Not automated yet.

---

## Troubleshooting

**"Sample data" still showing after deploy** — means the fetch for `/chat.txt` failed. Check that `public/chat.txt` is in your GitHub repo at that exact path. File has to be in `public/`, not the root.

**Dashboard shows 0 drinks** — the parser didn't match any rows. Usually means the export format is different (iOS vs Android, different locale date format). Open the browser devtools console; the parser is forgiving but not infinite. Share a sample line and it can be fixed.

**Total count looks wrong** — the checkpoint-based dedup anchors on the last legitimate numeric message in the chat. If the most recent numeric is a typo and above `MAX_CHECKPOINT_JUMP` from reality, bump that constant or just flip the "merge photo+number duplicate pairs" toggle off to see the raw row count.

**Deploy fails on Vercel** — check that `package.json` is at the root of what you uploaded, not inside a subfolder. If GitHub has e.g. `road-to-10k/road-to-10k/package.json` instead of `road-to-10k/package.json`, Vercel can't find it.
