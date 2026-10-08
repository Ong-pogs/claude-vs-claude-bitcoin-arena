# Claude vs Claude: a Bitcoin arena

Nine versions of Claude (Opus 5.5, Sonnet 5.5 and Haiku 5.5, each at low, high and max effort) get the same snapshot of Polymarket's 5-minute "Bitcoin Up or Down" market, at the same instant, with the same prompt. Each answers with its probability that Bitcoin finishes the window up, and a call: up, down or skip. Code places the paper bets, settles them on the market's real result and keeps score.

Every number the models see comes from the [Predictefy API](https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=nine-claudes-trade-bitcoin&utm_content=readme). The test runs on your own computer, with your own Predictefy key and your own Claude Code login. It never places a real order and never asks for a wallet key.

> Paper results are not real results. Fills are simulated at the real order book: no queue position, no market impact, and the only delay is the model's own thinking time. Nothing here is a reason to expect a profit.

## What it does

Every 5 minutes, for as many windows as you ask for (72 by default, which is 6 hours):

1. **Snapshot.** 45 seconds into the window it reads the market, both order books and the Chainlink BTC/USD rounds through Predictefy, and builds one JSON snapshot. Code does the arithmetic.
2. **Nine calls.** All nine versions are started at the same instant, in an order shuffled with a saved seed, through `claude -p`. Same prompt, same command; only `--model` and `--effort` change.
3. **Bets.** A call of up or down is a flat $5 paper bet. It fills when the answer arrives, by walking the real asks in the order book read through Predictefy at that moment, plus Polymarket's taker fee. Each version has a $100 budget.
4. **Deadline.** An answer that has not arrived 285 seconds into the window is a missed window: the call is stopped, there is no bet, and the round is scored as a coin flip.
5. **Result.** Bets settle on the result Polymarket publishes. Predictefy's last order book and its Chainlink feed are saved next to it as a cross-check.
6. **Score.** Hit rate and Brier score use every window for every version, bet or not. Three baselines that are not AI (a random pick, the market favourite, Bitcoin's direction since the open) play the same windows.

The dashboard shows the three-by-three grid, the paper money window by window, every window with each version's stated reason, one snapshot with the Predictefy calls behind it, the rules, and what the run cost in credits.

## Quick start

You need [Node.js](https://nodejs.org) 22.12 or newer, a Predictefy API key from [portal.predictefy.com/keys](https://portal.predictefy.com/keys), and [Claude Code](https://claude.com/claude-code) installed and logged in.

```bash
git clone https://github.com/Ong-pogs/claude-vs-claude-bitcoin-arena
cd claude-vs-claude-bitcoin-arena
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Open `.env` and paste your key after `PREDICTEFY_API_KEY=`. There is nothing to install: the code uses only what ships with Node.

```bash
node src/cli.mjs check            # one live snapshot through Predictefy. No Claude calls. 13 credits
node src/cli.mjs pilot --windows 1 --only haiku-low   # one window, cheapest version, to see the whole chain
node src/cli.mjs launch           # the full run, in the background
node src/cli.mjs status           # how it is going
node src/cli.mjs dashboard        # http://localhost:8821
```

| Command | What it does |
|---|---|
| `check` | Reads one snapshot and prints it. Add `--prompt` to print the exact prompt every version would get |
| `pilot` | A short trial in its own folder. `--windows 2`, `--only opus-low,haiku-max` |
| `launch` | Starts the full run as a background process that keeps going after you close the terminal. `--start-at 2026-10-08T11:25:00Z` holds the first window until then |
| `start` | The same run in the terminal you are looking at |
| `status` | Status, heartbeat, windows counted and each version's numbers |
| `stop` | Asks the run to stop after the window it is in |
| `resume` | Continues a stopped or interrupted run from the state on disk |
| `dashboard` | Serves the dashboard. `--replay path/to/state.json` shows a saved state without touching the API |

Add `--run <name>` to keep several runs apart. Everything a run produces is in `runs/<name>/`: one file per window, the raw Claude Code output of every call, every Predictefy call, and `state.json`.

## What this costs to run

**Predictefy credits.** A market lookup costs 1 credit, each order book 5 and the Chainlink rounds 2.

| Per window | Credits |
|---|---|
| Snapshot (market, two order books, Chainlink rounds) | 13 |
| One order book per bet placed | 5 each, up to 45 |
| Result check (two order books, Chainlink rounds) | 12 |

That is 25 credits for a window where nobody bets and 70 when all nine do. Predictefy's free plan gives 25,000 credits a month, enough for several six-hour runs. The dashboard shows what your own run used. If the API answers that your plan does not cover a request, the tool prints the upgrade link.

**Claude.** The calls go through your Claude Code login, so they count against your Claude plan: 9 calls per window. The low and high effort calls are small. The max effort calls think for one to four minutes each and are most of the usage. To try the idea cheaply, run a pilot with `--only haiku-low,haiku-high,sonnet-low`.

## The rules

They are in [`config/arena.json`](config/arena.json), enforced by code, and printed on the dashboard's **Rules and proof** tab.

| Rule | Default |
|---|---|
| Snapshot | 45 seconds into the window |
| Deadline for an answer | 285 seconds into the window |
| Stake and budget | $5 flat, $100 per version |
| Bet rule | `call`: a bet only when the call is up or down. `always`: every version holds a side in every window |
| Fee | Polymarket's crypto taker fee: shares x 0.07 x price x (1 - price) |
| Seed | 20261008, for the start order and the random baseline |

If your Claude plan's limit blocks a call, that window is thrown out for all nine and one more window is added at the end, so every version is always scored on the same windows. The run pauses until the limit resets.

## How the Claude call is kept clean

The same command for every version:

```
CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 DISABLE_AUTOUPDATER=1 claude -p --model <model> --effort <effort> --system-prompt "<the fixed system prompt>" --tools "" --safe-mode --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --output-format stream-json --verbose < prompt.txt
```

| Part | Why |
|---|---|
| `--tools ""` | No tools at all |
| `--safe-mode` | No CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands or agents |
| `--setting-sources ""` | No user, project or local settings, so no saved model or effort level |
| `--strict-mcp-config` | No MCP servers from any other configuration |
| `--no-session-persistence` | Nothing is saved, so no round can see an earlier one |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` | Stops Claude Code attaching a second, stronger model as an advisor |
| `DISABLE_AUTOUPDATER=1`, plus a copy of the program kept in the run folder | One Claude Code version for the whole run |
| An empty working folder, and no `CLAUDE*` or `ANTHROPIC*` variables from the parent | Nothing from your own session leaks in |

After every call the runner checks Claude Code's own output: the model it reports must be the one asked for and the only one, with no tools, no MCP servers and one turn. A call that fails the check throws the window out.

## What it cannot tell you

- **72 windows is a small sample.** Over 72 windows a coin flip lands anywhere from 28 to 44 correct, and the best of nine coin flips averages about 59%. The dashboard marks which gaps are inside that range.
- **The Bitcoin reference is close, not exact.** The market settles on Chainlink's BTC/USD 60-second TWAP data stream. Predictefy serves Chainlink's on-chain BTC/USD feed, which updates about every 33 seconds and can differ by a few dollars. The snapshot says so.
- **The result comes from the venue.** Predictefy marks these markets resolved but does not record which side won, so the published result is read from Polymarket's public market API. It is the only number that does not come from Predictefy.
- **Predictefy's paper engine does not cover these markets** (it answers `409 PAPER_NO_LIVE_BOOK`), which is why the ledger is local and every fill is labelled "simulated at the live Predictefy order book".
- **Other models.** Only Claude through Claude Code is wired up.

## Build it yourself

[`build-prompt.txt`](build-prompt.txt) is the full specification: the endpoints, the snapshot, the prompt, the fill and fee rules, the scoring and the dashboard. Paste it into an AI coding tool in an empty folder.

## Tests

```bash
node --test
```

26 tests cover the fill walk, the fee, settlement, scoring, the luck range, the snapshot, answer parsing and the baselines.

## License

MIT. See [LICENSE](LICENSE).
