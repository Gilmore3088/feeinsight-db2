# The model wrapper

Code: `src/model/wrapper.ts`. Tests: `src/model/wrapper.test.ts` (run with `npm test`).

## What it does
Every model call in DB2 goes through this one wrapper. No other file may call a model. It does
four things in plain code, with no model involved:

1. **Checks the price first.** Before sending, it works out the worst this call could cost: the
   prompt (estimated at one token per 3 characters, which runs high) plus the full `maxTokens`
   reply at the output price. If money spent so far plus that worst case would pass the cap, it
   refuses and sends nothing. The worst case of calls already sent and not yet answered counts
   too, so several calls at the same time cannot add up to more than the cap.
2. **Pauses at the pause point.** Once money spent reaches the pause point, every call is refused
   until a person resumes.
3. **Writes every call to a ledger**, including refused ones: time, agent, run, model, tokens, cost,
   outcome (`ok`, `refused_cap`, `refused_pause`, `error`) and a note.
4. **Retries carefully.** A 429, a 5xx or a network failure is retried at most twice, waiting 1 s
   then 2 s. Each retry re-checks the pause and the cap. A request that failed but reports tokens
   used is still charged. A 4xx (other than 429) is not retried.

The API key is passed in by the caller to `anthropicTransport` and is used only in the request
header. It is never logged, stored or put in an error. Error messages carry only the status number,
never text from the provider.

## The cap and the pause
- **Cap**: the hard ceiling. It cannot be changed on a running client. Raising it means building a
  new client with a larger `capUsd`, and **that needs James's yes**.
- **Pause point**: a lower line. When spending reaches it, work stops. A person restarts it with
  `resume(newPauseAtUsd, by, why)`. It needs an explicit number above what is spent and no higher than
  the cap, plus who and why, which go in the ledger. Agents cannot call this on their own.
- **Confirmed numbers (James, 2026-11-21)**: model **Sonnet 5.5** (`claude-sonnet-5-5`), a
  **$200 total cap** across all runs, with work stopping at the cap for his word. Any single run
  likely to cost more than **$25** still needs his yes before it starts. The wrapper still has no
  default cap: the caller passes `capUsd` and `pauseAtUsd`, and the reader passes these numbers.

## Prices
Prices (USD per million input and output tokens, per model id) are passed in by the caller. There is
no built-in table. A model with no price throws `UnknownModelError`. The reader passes Anthropic's
list price for Sonnet 5.5 as of November 2026: **$2 input, $10 output** per million tokens (thinking
tokens bill as output). Check the price list again before relying on it for a large run.

## Where the key is set

The runs happen in the cloud environment that holds this repo, so a key on James's own computer does not
reach them. James adds `ANTHROPIC_API_KEY` himself as an environment variable of that cloud environment
(never pasted into a chat, a commit or a report). If he runs DB2 on his own machine instead, he sets it
in his shell or in a `.env` file at the repo root (`.env` is in `.gitignore`). The code reads it from
the environment and passes it to `anthropicTransport({ apiKey })`; with no key, a model step stops
before it spends anything.

## Not built yet
- **A database ledger.** Only the `SpendLedger` interface and an in-memory version (for tests)
  exist. A database ledger needs a migration, which needs James's yes. Until then, spending is
  forgotten when the process ends, so the cap only holds within one run.
- **Real spend numbers.** Nothing here has called a real model. Costs are from the token counts the
  provider returns, and no actual spend has been measured.
- A `DEFAULT_PRICES` table (see above).
