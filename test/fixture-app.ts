/**
 * A tiny shop to test against, served locally so tests never depend on a
 * public site. Log in → shop → cart, or shop → profile. Logging in sets a
 * cookie, and /shop sends you back to sign in without it. Switches let a test change the app
 * between runs, the way a real app changes between deploys:
 *
 *   promo   the Cart link goes through a new /promo page first  (→ drift)
 *   broken    the cart page logs a console error and gets a 500  (→ findings)
 *   commission  what POST /api/visits says the commission is (default 12)
 *               — /book's "Book" button calls it, then says "Booked"
 *   approved  /approval shows "Visit accepted" — what a provider does
 *             elsewhere, the step only a person can do. Until then it
 *             says it is waiting, and checks again every 300 ms.
 *
 * And a checkout with two commit steps, like a booking: /checkout has a
 * checkbox hidden under a styled box that toggles it (only a forced click gets
 * through) that
 * enables "Confirm & Submit", which leads to /pay and "Pay Now". `committed()`
 * counts what was actually submitted, so a test can show nothing was bought.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureApp {
  url: string;
  set(opts: { promo?: boolean; broken?: boolean; approved?: boolean; commission?: number }): void;
  /** How many times each commit was really submitted. */
  committed(): { confirmed: number; paid: number };
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

export async function startFixtureApp(): Promise<FixtureApp> {
  let promo = false;
  let broken = false;
  let approved = false;
  let commission = 12;
  let confirmed = 0;
  let paid = 0;

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
    if (path === '/checkout') {
      return html(page('Shop — checkout', `
        <h1>Checkout</h1>
        <form method="post" action="/confirm">
          <span style="position:relative;display:inline-block;width:24px;height:24px">
            <input type="checkbox" id="agree" aria-label="I agree to the terms" style="position:absolute;inset:0;margin:0"
              onchange="document.getElementById('go').disabled = !this.checked">
            <span style="position:absolute;inset:0;background:#36c;border-radius:4px"
              onclick="const b = document.getElementById('agree'); b.checked = !b.checked; b.dispatchEvent(new Event('change'))"></span>
          </span>
          <button id="go" type="submit" disabled>Confirm &amp; Submit</button>
        </form>`));
    }
    if (path === '/book') {
      return html(page('Shop — book', `<h1>Book a visit</h1><p id="state"></p>
        <button onclick="fetch('/api/visits', { method: 'POST' }).then(() => { document.getElementById('state').textContent = 'Booked'; })">Book</button>`));
    }
    if (path === '/api/visits' && req.method === 'POST') {
      return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 7, commission: { amount: commission } }));
    }
    if (path === '/approval') {
      return html(approved
        ? page('Shop — visit', '<h1>Visit accepted</h1>')
        : page('Shop — visit', '<h1>Waiting for the provider</h1><script>setTimeout(() => location.reload(), 300)</script>'));
    }
    if (path === '/confirm' && req.method === 'POST') {
      confirmed++;
      return res.writeHead(303, { location: '/pay' }).end();
    }
    if (path === '/pay') {
      return html(page('Shop — pay', `<h1>Pay</h1><form method="post" action="/paid"><button type="submit">Pay Now</button></form>`));
    }
    if (path === '/paid' && req.method === 'POST') {
      paid++;
      return html(page('Shop — paid', `<h1>Thank you</h1>`));
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
      if (o.approved !== undefined) approved = o.approved;
      if (o.commission !== undefined) commission = o.commission;
    },
    committed: () => ({ confirmed, paid }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
