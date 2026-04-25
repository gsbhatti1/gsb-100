# NNN Scout Setup

The `nnn-scout-agent` is now in the repo and scheduled every 30 minutes.

## What It Does

- opens your real browser profile
- checks Crexi and LoopNet search result pages
- looks for NNN / net-lease language
- extracts price, NOI, cap rate when present
- runs 10 / 20 / 30 year debt scenarios at 20% and 25% down
- sends hot matches to Telegram
- saves matches into `buyer_matches`

## What You Need To Add In `.env`

```env
SEARCH_URLS_CREXI=https://www.crexi.com/search/saved-search-1,https://www.crexi.com/search/saved-search-2
SEARCH_URLS_LOOPNET=https://www.loopnet.com/search/saved-search-1,https://www.loopnet.com/search/saved-search-2
CURRENT_MORTGAGE_RATE=6.75
BROWSER_PROFILE_DIR=C:/gsb-100/data/browser-profile
```

## First Login

Run the agent once manually:

```powershell
cd C:\gsb-100
$env:RUN_ONCE='1'
node .\agents\nnn-scout-agent.js
```

Log into Crexi and LoopNet in the opened browser window if prompted.

After that, the profile stays on disk and the agent reuses it.

## Important

The first version is focused on search-result scouting and underwriting alerts.
The next upgrade is:

- open each listing detail page
- capture flyer / OM PDF link when present
- attach richer client-ready text blocks
