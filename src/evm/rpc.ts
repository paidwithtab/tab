// A minimal Ethereum JSON-RPC client over global fetch. Built for Robinhood
// Chain (an Arbitrum-stack L2) but plain EVM throughout. 20 s per call,
// receipt polling for up to 30 s.
//
// The url may be a comma-separated list. Transport failures (connection errors,
// timeouts, HTTP 403/429/5xx) move on to the next endpoint and the client stays
// on whichever endpoint last answered. JSON-RPC errors are answers from the
// chain (reverts, insufficient funds, bad nonce) and are never retried elsewhere.

import { bytesToHex, hexToBig, bigToHex, erc20 } from './tx.js';

export class EvmRpcError extends Error {
  constructor(message: string, public data?: unknown) {
    super(message);
    this.name = 'EvmRpcError';
  }
}

/** A transport failure at one endpoint: connection, timeout, HTTP status or unparsable body. Retried on the next endpoint. */
class EvmTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvmTransportError';
  }
}

/** An eth_call revert — distinguishable from transport failures. */
export class EvmRevert extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvmRevert';
  }
}

export class EvmRpc {
  private nextId = 1;
  /** Every endpoint, in the order given. */
  readonly urls: string[];
  /** Index of the endpoint that last answered; the next call starts there. */
  private current = 0;

  constructor(public readonly url: string, private timeoutMs = 20_000) {
    this.urls = url.split(',').map((u) => u.trim()).filter(Boolean);
    if (this.urls.length === 0) throw new EvmRpcError('no rpc url');
  }

  async call(method: string, params: unknown[] = []): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    let lastErr: unknown;
    for (let i = 0; i < this.urls.length; i++) {
      const idx = (this.current + i) % this.urls.length;
      try {
        const result = await this.callOne(this.urls[idx], method, body);
        this.current = idx;
        return result;
      } catch (e) {
        if (!(e instanceof EvmTransportError)) throw e; // a chain answer: do not ask another node
        lastErr = e;
      }
    }
    const err = lastErr as EvmTransportError;
    throw new EvmRpcError(`${method}: ${err.message}${this.urls.length > 1 ? ` (all ${this.urls.length} endpoints failed)` : ''}`);
  }

  private async callOne(url: string, method: string, body: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new EvmTransportError(`${(e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message} at ${url}`);
    }
    if (!res.ok) throw new EvmTransportError(`HTTP ${res.status} at ${url}`);
    let parsed: { result?: unknown; error?: { message: string; data?: unknown } };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      throw new EvmTransportError(`bad json at ${url}`);
    }
    if (parsed.error) {
      const msg = parsed.error.message ?? 'rpc error';
      if (/revert|execution reverted/i.test(msg)) throw new EvmRevert(`${msg}`);
      throw new EvmRpcError(`${method}: ${msg}`, parsed.error.data);
    }
    return parsed.result;
  }

  async chainId(): Promise<bigint> {
    return hexToBig(await this.call('eth_chainId'));
  }

  async transactionCount(address: string): Promise<bigint> {
    return hexToBig(await this.call('eth_getTransactionCount', [address, 'pending']));
  }

  async gasPrice(): Promise<bigint> {
    return hexToBig(await this.call('eth_gasPrice'));
  }

  async maxPriorityFeePerGas(): Promise<bigint> {
    try {
      return hexToBig(await this.call('eth_maxPriorityFeePerGas'));
    } catch {
      return 0n; // many L2s (Arbitrum stack included) run fine with a zero tip
    }
  }

  async balance(address: string): Promise<bigint> {
    return hexToBig(await this.call('eth_getBalance', [address, 'latest']));
  }

  /** eth_call; throws EvmRevert if the call reverts. Returns the raw hex result. */
  async ethCall(to: string, data: Uint8Array, from?: string): Promise<string> {
    return (await this.call('eth_call', [
      { to, data: bytesToHex(data), ...(from ? { from } : {}) },
      'latest',
    ])) as string;
  }

  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    return (await this.call('eth_sendRawTransaction', [bytesToHex(raw)])) as string;
  }

  /** Poll until the transaction is mined or ~30 s pass. Throws if it reverted on-chain. */
  async waitForReceipt(hash: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.call('eth_getTransactionReceipt', [hash]);
      if (receipt) {
        if (typeof receipt.transactionHash === 'string' && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
          throw new EvmRpcError(`node answered with the receipt of ${receipt.transactionHash}, not ${hash}`);
        }
        if (receipt.status === '0x1') return;
        throw new EvmRpcError(`transaction ${hash} reverted on-chain`);
      }
      if (Date.now() > deadline) throw new EvmRpcError(`no receipt for ${hash} within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  // -- ERC-20 reads ---------------------------------------------------------

  async erc20BalanceOf(token: string, owner: string): Promise<bigint> {
    return hexToBig(await this.ethCall(token, erc20.balanceOf(owner)));
  }

  async erc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
    return hexToBig(await this.ethCall(token, erc20.allowance(owner, spender)));
  }

  async erc20Decimals(token: string): Promise<number> {
    return Number(hexToBig(await this.ethCall(token, erc20.decimals())));
  }
}

export { bigToHex };
