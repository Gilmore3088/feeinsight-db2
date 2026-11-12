// The one model wrapper. All DB2 code that calls a model goes through here, so one hard
// spend cap covers everything. Plain code: no dependencies, no model decides money matters.
// Rules are written out in docs/model-wrapper.md. Change them there and here together.

export interface Message { role: 'user' | 'assistant'; content: string }

export interface Usage { inputTokens: number; outputTokens: number }

export interface TransportRequest {
  model: string;
  system: string;
  messages: Message[];
  maxTokens: number;
}

export interface TransportResponse { text: string; usage: Usage }

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** What a transport throws when the request fails. `usage` is set when the provider says tokens were used. */
export class TransportError extends Error {
  status?: number;
  usage?: Usage;
  constructor(message: string, opts: { status?: number; usage?: Usage } = {}) {
    super(message);
    this.name = 'TransportError';
    this.status = opts.status;
    this.usage = opts.usage;
  }
}

/** USD per million tokens, by model id. The caller supplies this; the wrapper has no built-in prices. */
export type PriceTable = Record<string, { inputPerMillion: number; outputPerMillion: number }>;

export type Outcome = 'ok' | 'refused_cap' | 'refused_pause' | 'error';

export interface LedgerEntry {
  time: Date;
  agent: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: Outcome;
  note: string;
}

export interface SpendLedger {
  total(): number;
  record(entry: LedgerEntry): void;
}

export class InMemoryLedger implements SpendLedger {
  readonly entries: LedgerEntry[] = [];
  total(): number { return this.entries.reduce((sum, e) => sum + e.costUsd, 0); }
  record(entry: LedgerEntry): void { this.entries.push(entry); }
}

export class SpendCapError extends Error {
  spentUsd: number; worstCaseUsd: number; capUsd: number;
  constructor(spentUsd: number, worstCaseUsd: number, capUsd: number) {
    super(`refused: spent $${spentUsd.toFixed(4)} + worst case $${worstCaseUsd.toFixed(4)} would pass the cap of $${capUsd.toFixed(2)}`);
    this.spentUsd = spentUsd; this.worstCaseUsd = worstCaseUsd; this.capUsd = capUsd;
    this.name = 'SpendCapError';
  }
}

export class SpendPausedError extends Error {
  spentUsd: number; pauseAtUsd: number;
  constructor(spentUsd: number, pauseAtUsd: number) {
    super(`paused: spent $${spentUsd.toFixed(4)} reached the pause point of $${pauseAtUsd.toFixed(2)}; a person must resume`);
    this.spentUsd = spentUsd; this.pauseAtUsd = pauseAtUsd;
    this.name = 'SpendPausedError';
  }
}

export class UnknownModelError extends Error {
  model: string;
  constructor(model: string) {
    super(`no price for model "${model}"; add it to the price table`);
    this.model = model;
    this.name = 'UnknownModelError';
  }
}

/** The request failed and could not be completed. The message never carries provider text. */
export class ModelCallError extends Error {
  status?: number;
  constructor(status?: number) {
    super(status ? `model call failed (status ${status})` : 'model call failed (no response)');
    this.status = status;
    this.name = 'ModelCallError';
  }
}

export interface CallInput {
  agent: string;
  runId: string;
  model: string;
  system: string;
  messages: Message[];
  maxTokens: number;
}

export interface CallResult { text: string; usage: Usage; costUsd: number }

export interface ModelClientOptions {
  transport: Transport;
  prices: PriceTable;
  /** Hard cap in USD. No default. Raising it needs James's yes, and means building a new client. */
  capUsd: number;
  /** Calls stop once spent reaches this. A person raises it with resume(). */
  pauseAtUsd: number;
  ledger: SpendLedger;
  now: () => Date;
  /** Waits between retries. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_RETRIES = 2;
const FIRST_WAIT_MS = 1000;
const CHARS_PER_TOKEN = 3; // deliberately low, so the input estimate runs high

const usd = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;

function isRetryable(err: unknown): boolean {
  const status = err instanceof TransportError ? err.status : undefined;
  return status === undefined || status === 429 || status >= 500;
}

export function createModelClient(opts: ModelClientOptions) {
  const { transport, prices, capUsd, ledger, now } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new RangeError('capUsd must be a positive number');
  if (!Number.isFinite(opts.pauseAtUsd) || opts.pauseAtUsd <= 0 || opts.pauseAtUsd > capUsd) {
    throw new RangeError('pauseAtUsd must be a positive number no higher than capUsd');
  }
  let pauseAtUsd = opts.pauseAtUsd;

  const spent = () => ledger.total();
  const remaining = () => capUsd - spent();

  function log(input: CallInput, outcome: Outcome, note: string, usage: Usage = { inputTokens: 0, outputTokens: 0 }, costUsd = 0) {
    ledger.record({
      time: now(), agent: input.agent, runId: input.runId, model: input.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd, outcome, note,
    });
  }

  function worstCase(input: CallInput, price: PriceTable[string]): number {
    const chars = input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
    return usd(inputTokens, price.inputPerMillion) + usd(input.maxTokens, price.outputPerMillion);
  }

  async function call(input: CallInput): Promise<CallResult> {
    const price = prices[input.model];
    if (!price) {
      log(input, 'error', 'unknown model');
      throw new UnknownModelError(input.model);
    }
    const request: TransportRequest = {
      model: input.model, system: input.system, messages: input.messages, maxTokens: input.maxTokens,
    };
    const worst = worstCase(input, price);

    for (let attempt = 0; ; attempt++) {
      // Checked before every send, retries included, against what has been spent so far.
      if (spent() >= pauseAtUsd) {
        log(input, 'refused_pause', `spent $${spent().toFixed(4)}, pause point $${pauseAtUsd}`);
        throw new SpendPausedError(spent(), pauseAtUsd);
      }
      if (spent() + worst > capUsd) {
        log(input, 'refused_cap', `worst case $${worst.toFixed(4)}, attempt ${attempt + 1}`);
        throw new SpendCapError(spent(), worst, capUsd);
      }
      try {
        const res = await transport(request);
        const cost = usd(res.usage.inputTokens, price.inputPerMillion) + usd(res.usage.outputTokens, price.outputPerMillion);
        log(input, 'ok', attempt ? `after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}` : '', res.usage, cost);
        return { text: res.text, usage: res.usage, costUsd: cost };
      } catch (err) {
        const status = err instanceof TransportError ? err.status : undefined;
        const usage = err instanceof TransportError ? err.usage : undefined;
        const cost = usage ? usd(usage.inputTokens, price.inputPerMillion) + usd(usage.outputTokens, price.outputPerMillion) : 0;
        // Only the status goes in the note: provider text could echo a secret.
        log(input, 'error', `attempt ${attempt + 1} failed${status ? ` (status ${status})` : ''}`, usage, cost);
        if (attempt >= MAX_RETRIES || !isRetryable(err)) throw new ModelCallError(status);
        await sleep(FIRST_WAIT_MS * 2 ** attempt);
      }
    }
  }

  /** A person raises (or lowers) the pause point. Needs an explicit number, who, and why. The cap does not move. */
  function resume(newPauseAtUsd: number, by: string, why: string): void {
    if (typeof newPauseAtUsd !== 'number' || !Number.isFinite(newPauseAtUsd) || newPauseAtUsd <= spent() || newPauseAtUsd > capUsd) {
      throw new RangeError('new pause point must be a number above what is spent and no higher than the cap');
    }
    if (!by.trim() || !why.trim()) throw new Error('resume needs who and why');
    const from = pauseAtUsd;
    pauseAtUsd = newPauseAtUsd;
    ledger.record({
      time: now(), agent: 'person', runId: '', model: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
      outcome: 'ok', note: `resume by ${by}: pause point $${from} to $${newPauseAtUsd}. ${why}`,
    });
  }

  return { call, resume, spent, remaining, capUsd, pauseAt: () => pauseAtUsd };
}

export type ModelClient = ReturnType<typeof createModelClient>;

/** Calls the Anthropic Messages API over HTTPS. The key is used only in the request header. */
export function anthropicTransport(opts: { apiKey: string; fetch?: typeof fetch }): Transport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return async (req) => {
    let res: Response;
    try {
      res = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages }),
      });
    } catch {
      throw new TransportError('network error');
    }
    let body: any = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const u = body?.usage;
    const usage = u && typeof u.input_tokens === 'number'
      ? { inputTokens: u.input_tokens, outputTokens: Number(u.output_tokens) || 0 }
      : undefined;
    if (!res.ok) throw new TransportError(`provider error ${res.status}`, { status: res.status, usage });
    if (!usage) throw new TransportError('provider reply had no usage', { status: res.status });
    const text = Array.isArray(body.content) ? body.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') : '';
    return { text, usage };
  };
}
