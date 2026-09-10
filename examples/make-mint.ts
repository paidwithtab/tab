// Fabricate a 6-decimal SPL stablecoin on a local validator: create the mint,
// create the owner's ATA, mint sandbox "USDC" into it. Prints MINT=<address>.
//
//   SOLANA_RPC=http://127.0.0.1:8899 npx tsx examples/make-mint.ts <payer.json> <owner.json> [amountUsd]

import { loadKey, newKeyPair, pubBytes } from '../src/keys.js';
import { usdToMicro } from '../src/protocol.js';
import { b58encode } from '../src/solana/base58.js';
import { ata, TOKEN_PROGRAM } from '../src/solana/pda.js';
import { SolanaRpc } from '../src/solana/rpc.js';
import {
  systemCreateAccount,
  initializeMint2,
  createAtaIdempotent,
  mintTo,
  type Instruction,
} from '../src/solana/instructions.js';
import { compileMessage, serializeTransaction } from '../src/solana/tx.js';
import { signBytes, type KeyPair } from '../src/keys.js';

export async function makeMint(
  rpc: SolanaRpc,
  payer: KeyPair,
  owner: string, // wallet id (base64url)
  amountUsd: string,
): Promise<string> {
  const mintPair = newKeyPair();
  const payerPub = pubBytes(payer.publicKey);
  const mintPub = pubBytes(mintPair.publicKey);
  const ownerPub = pubBytes(owner);
  const rent = await rpc.getMinimumBalanceForRentExemption(82);
  const ownerAta = ata(ownerPub, mintPub);

  const send = async (instructions: Instruction[], signers: KeyPair[]) => {
    const blockhash = await rpc.getLatestBlockhash();
    const compiled = compileMessage(payerPub, blockhash, instructions);
    const byPub = new Map(signers.map((s) => [b58encode(pubBytes(s.publicKey)), s]));
    const signatures = compiled.accounts.slice(0, compiled.numRequiredSignatures).map((acc) => {
      const pair = byPub.get(acc);
      if (!pair) throw new Error(`missing signer ${acc}`);
      return new Uint8Array(Buffer.from(signBytes(pair, compiled.bytes), 'base64url'));
    });
    const sig = await rpc.sendTransaction(
      Buffer.from(serializeTransaction({ signatures, message: compiled.bytes })).toString('base64'),
    );
    await rpc.confirm(sig);
    return sig;
  };

  await send(
    [
      systemCreateAccount(payerPub, mintPub, rent, 82n, TOKEN_PROGRAM),
      initializeMint2(mintPub, 6, payerPub),
      createAtaIdempotent(payerPub, ownerAta, ownerPub, mintPub),
      mintTo(mintPub, ownerAta, payerPub, BigInt(usdToMicro(amountUsd))),
    ],
    [payer, mintPair],
  );
  return b58encode(mintPub);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [payerPath, ownerPath, amount] = process.argv.slice(2);
  if (!payerPath || !ownerPath) {
    console.error('usage: make-mint.ts <payer.json> <owner.json|pub> [amountUsd]');
    process.exit(1);
  }
  const rpc = new SolanaRpc(process.env.SOLANA_RPC || 'http://127.0.0.1:8899');
  const owner = ownerPath.endsWith('.json') ? loadKey(ownerPath).publicKey : ownerPath;
  makeMint(rpc, loadKey(payerPath), owner, amount ?? '100.00')
    .then((mint) => console.log(`MINT=${mint}`))
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exit(1);
    });
}
