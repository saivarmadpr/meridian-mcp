import { generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, type JWK } from 'jose';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

export const ALG = 'EdDSA' as const;

/** Whatever key representation jose returns for our algorithm (CryptoKey/KeyObject/Uint8Array). */
type Key = Awaited<ReturnType<typeof importJWK>>;

export interface KeyStore {
  kid: string;
  alg: typeof ALG;
  privateKey: Key;
  publicKey: Key;
  publicJwk: JWK & { kid: string; alg: string; use: string };
}

let cached: Promise<KeyStore> | null = null;

/** Lazily builds (and memoizes) the Ed25519 signing keys. */
export function keyStore(): Promise<KeyStore> {
  return (cached ??= build());
}

async function build(): Promise<KeyStore> {
  let privateJwk: JWK;

  if (config.AUTH_SIGNING_KEY) {
    privateJwk = JSON.parse(config.AUTH_SIGNING_KEY) as JWK;
  } else {
    const { privateKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
    privateJwk = await exportJWK(privateKey);
    logger.warn(
      'AUTH_SIGNING_KEY not set — generated an EPHEMERAL Ed25519 key. Tokens will not survive a restart. Set AUTH_SIGNING_KEY in production.',
    );
  }

  const privateKey = await importJWK(privateJwk, ALG);
  const publicJwkRaw = { ...privateJwk };
  delete (publicJwkRaw as Record<string, unknown>).d; // strip private scalar
  const kid = privateJwk.kid ?? (await calculateJwkThumbprint(publicJwkRaw));
  const publicKey = await importJWK(publicJwkRaw, ALG);

  const publicJwk = { ...publicJwkRaw, kid, alg: ALG, use: 'sig' } as KeyStore['publicJwk'];

  return { kid, alg: ALG, privateKey, publicKey, publicJwk };
}

/** JWKS document served at the authorization server's `jwks_uri`. */
export async function getJwks(): Promise<{ keys: JWK[] }> {
  const ks = await keyStore();
  return { keys: [ks.publicJwk] };
}
