// A minimal Ethereum JSON-RPC client over global fetch. Built for Robinhood
// Chain (an Arbitrum-stack L2) but plain EVM throughout. 20 s per call,
// receipt polling for up to 30 s.

import { bytesToHex, hexToBig, bigToHex, erc20 } from './tx.js';

export class EvmRpcError extends Error {
  constructor(message: string, public data?: unknown) {
    super(message);
    this.name = 'EvmRpcError';
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

  constructor(public readonly url: string, private timeoutMs = 20_000) {}

  async call(method: string, params: unknown[] = []): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new EvmRpcError(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
    if (body.error) {
      const msg = body.error.message ?? 'rpc error';
      if (/revert|execution reverted/i.test(msg)) throw new EvmRevert(`${msg}`);
      throw new EvmRpcError(`${method}: ${msg}`, body.error.data);
    }
    return body.result;
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
