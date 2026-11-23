/**
 * A tiny shop to test against, served locally so tests never depend on a
 * public site. Log in → shop → cart, or shop → profile. Logging in sets a
 * cookie, and /shop sends you back to sign in without it. Switches let a test change the app
 * between runs, the way a real app changes between deploys:
 *
 *   promo   the Cart link goes through a new /promo page first  (→ drift)
 *   broken  the cart page logs a console error and gets a 500    (→ findings)
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureApp {
  url: string;
  set(opts: { promo?: boolean; broken?: boolean }): void;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

export async function startFixtureApp(): Promise<FixtureApp> {
  let promo = false;
  let broken = false;

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const html = (s: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(s);

    if (path === '/' && req.method === 'GET') {
      return html(page('Shop — sign in', `
        <h1>Sign in</h1>
        <form method="post" action="/login">
          <label>Username <input name="u" placeholder="you@example.com"></label>
          <label>Password <input name="p" type="password"></label>
          <button type="submit">Log in</button>
        </form>`));
    }
    // Signing in sets a cookie; the shop sends you back to sign in without it.
    if (path === '/login') return res.writeHead(303, { location: '/shop', 'set-cookie': 'sid=demo; Path=/; HttpOnly' }).end();
    const signedIn = /(^|;\s*)sid=demo(;|$)/.test(req.headers.cookie ?? '');
    if (path === '/shop' && !signedIn) return res.writeHead(303, { location: '/' }).end();
    if (path === '/shop') {
      return html(page('Shop', `
        <h1>Shop</h1>
        <nav><a href="${promo ? '/promo' : '/cart'}">Cart</a> <a href="/profile">Profile</a></nav>`));
    }
    if (path === '/profile') {
      return html(page('Shop — profile', `<h1>Your profile</h1><p>demo</p>`));
    }
    if (path === '/promo') {
      return html(page('Shop — offer', `<h1>Special offer</h1><a href="/cart">Continue to cart</a>`));
    }
    if (path === '/cart') {
      const boom = broken ? `<script>console.error('cart widget failed'); fetch('/api/cart');</script>` : '';
      return html(page('Shop — cart', `<h1>Your cart</h1><p>Empty</p>${boom}`));
    }
    if (path === '/api/cart') return res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    res.writeHead(404).end('not found');
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    set: (o) => {
      if (o.promo !== undefined) promo = o.promo;
      if (o.broken !== undefined) broken = o.broken;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
