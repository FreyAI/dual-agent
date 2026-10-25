/**
 * A self-signed certificate for one host (api.anthropic.com), so the local
 * proxy can read a signed-in Claude chat's requests while Claude Code still
 * talks to api.anthropic.com, which Remote Control requires. Only the Claude
 * Code process that gets it in NODE_EXTRA_CA_CERTS trusts it, and it is valid
 * for that host alone. Built with Node's crypto (no openssl on Windows); RSA,
 * since Claude Code's TLS refused a P-256 certificate (EPROTO, 2026-10-20).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ---- Minimal DER ----
const len = (n: number) => {
  if (n < 0x80) {
    return Buffer.from([n]);
  }
  const bytes: number[] = [];
  for (; n; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const int = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (s: string) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const arcs = rest.map((n) => {
    const out = [n & 0x7f];
    for (n >>= 7; n; n >>= 7) out.unshift(0x80 | (n & 0x7f));
    return Buffer.from(out);
  });
  return tlv(0x06, Buffer.from([40 * a + b]), ...arcs);
};
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const NULL = Buffer.from([0x05, 0x00]);
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), tlv(0x04, value));

const SHA256_RSA = '1.2.840.113549.1.1.11';
const DAY = 86_400_000;

export interface HostCert { key: string; cert: string }

/** A new key and a certificate for `host`, valid for `days` from yesterday. */
export function makeHostCert(host: string, days = 365, now = Date.now()): HostCert {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(host)))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    seq(oid(SHA256_RSA), NULL),
    name,
    seq(utc(new Date(now - DAY)), utc(new Date(now + days * DAY))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, seq(tlv(0x82, Buffer.from(host)))),
    )),
  );
  const der = seq(tbs, seq(oid(SHA256_RSA), NULL), tlv(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert };
}

/** The certificate in `dir` for `host`, made (or remade within 30 days of expiry) as needed; the key is readable by the user only. */
export function hostCert(dir: string, host: string, now = Date.now()): HostCert & { certFile: string } {
  const keyFile = path.join(dir, `${host}.key`);
  const certFile = path.join(dir, `${host}.pem`);
  try {
    const cert = fs.readFileSync(certFile, 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (x.checkHost(host) && Date.parse(x.validTo) - now > 30 * DAY) {
      return { key: fs.readFileSync(keyFile, 'utf8'), cert, certFile };
    }
  } catch {
    // Missing or unreadable: make a new one.
  }
  const made = makeHostCert(host, 365, now);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, made.key, { mode: 0o600 });
  fs.writeFileSync(certFile, made.cert);
  return { ...made, certFile };
}
