// A minimal Solana JSON-RPC client over global fetch. 20 s per call,
// confirmation polls for up to 30 s.

export class RpcError extends Error {
  constructor(message: string, public data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface TokenAccountInfo {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
}

import { b58encode, b58decode } from './base58.js';

export class SolanaRpc {
  private nextId = 1;

  constructor(public readonly url: string, private timeoutMs = 20_000) {}

  async call(method: string, params: unknown[] = []): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.data);
    return body.result;
  }

  async getLatestBlockhash(): Promise<string> {
    const r = await this.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return r.value.blockhash as string;
  }

  async getBalance(address58: string): Promise<bigint> {
    const r = await this.call('getBalance', [address58, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  async requestAirdrop(address58: string, lamports: bigint): Promise<string> {
    return (await this.call('requestAirdrop', [address58, Number(lamports)])) as string;
  }

  async getMinimumBalanceForRentExemption(space: number): Promise<bigint> {
    return BigInt(await this.call('getMinimumBalanceForRentExemption', [space]));
  }

  async simulateTransaction(txBase64: string): Promise<{ err: unknown; logs: string[] }> {
    const r = await this.call('simulateTransaction', [
      txBase64,
      { encoding: 'base64', sigVerify: true, commitment: 'processed' },
    ]);
    return { err: r.value.err ?? null, logs: (r.value.logs ?? []) as string[] };
  }

  async sendTransaction(txBase64: string): Promise<string> {
    return (await this.call('sendTransaction', [
      txBase64,
      { encoding: 'base64', skipPreflight: true, maxRetries: 5 },
    ])) as string;
  }

  /** Poll until the signature is confirmed or ~30 s pass. Throws on on-chain error. */
  async confirm(signature: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = r.value?.[0];
      if (status) {
        if (status.err) throw new RpcError(`transaction failed: ${JSON.stringify(status.err)}`);
        const c = status.confirmationStatus;
        if (c === 'confirmed' || c === 'finalized') return;
      }
      if (Date.now() > deadline) throw new RpcError(`confirmation timed out for ${signature}`);
      await new Promise((r2) => setTimeout(r2, 700));
    }
  }

  /** Parse an SPL token account. Returns null if the account does not exist. */
  async getTokenAccount(address58: string): Promise<TokenAccountInfo | null> {
    const r = await this.call('getAccountInfo', [address58, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r.value) return null;
    const data = Buffer.from(r.value.data[0], 'base64');
    if (data.length < 165) return null;
    const delegateOpt = data.readUInt32LE(72);
    return {
      mint: b58encode(new Uint8Array(data.subarray(0, 32))),
      owner: b58encode(new Uint8Array(data.subarray(32, 64))),
      amount: data.readBigUInt64LE(64),
      delegate: delegateOpt === 1 ? b58encode(new Uint8Array(data.subarray(76, 108))) : null,
      delegatedAmount: data.readBigUInt64LE(121),
    };
  }

  /** Token balance in base units; 0 if the account does not exist. */
  async tokenBalance(address58: string): Promise<bigint> {
    const acc = await this.getTokenAccount(address58);
    return acc ? acc.amount : 0n;
  }
}

export { b58encode, b58decode };
