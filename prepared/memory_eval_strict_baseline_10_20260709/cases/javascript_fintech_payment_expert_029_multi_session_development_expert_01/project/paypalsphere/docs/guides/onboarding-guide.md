```markdown
# PayPalsphere Developer Guide
## Circle & User On-Boarding

Welcome to **PayPalsphere’s** onboarding guide.  
This document shows you how to use our JavaScript SDK to:

1. Bootstrap the SDK with your credentials.  
2. Create a new social‐payment “Circle.”  
3. Invite members with one-click KYC.  
4. Subscribe to **CQRS / Event-Sourced** webhooks (KYC, Risk, Settlement).  
5. Complete the first “social-payment” together.

> ℹ️ **Audience** – JavaScript / Node.js developers building server-side integrations for PayPalsphere.

---

## 1. Prerequisites

| Requirement                     | Minimum Version |
| ------------------------------- | --------------- |
| Node.js (LTS)                   | `18.x`          |
| NPM or PNPM                     | `v7+`           |
| PayPalsphere Developer Account  | —               |
| Public webhook endpoint (HTTPS) | —               |

```bash
# Create a new project
mkdir my-circle-app && cd $_
pnpm init -y        # or `npm init -y`
pnpm add @paypalsphere/sdk dotenv express
```

---

## 2. Configuration

Create a `.env` file (never commit this!) and populate it with your app’s credentials:

```env
PPSPHERE_CLIENT_ID     = psp_svc_123...      # From developer portal
PPSPHERE_CLIENT_SECRET = sec_svc_abc...
PPSPHERE_WEBHOOK_SECRET= whsec_…
PPSPHERE_ENV           = sandbox             # or `production`
```

---

## 3. Quick-Start Script

`src/onboardCircle.js`

```js
/**
 * A complete sample illustrating:
 * 1. OAuth2 token retrieval
 * 2. Circle creation
 * 3. Member invitation with KYC
 * 4. Event-sourced subscription to updates
 */

import 'dotenv/config';
import { PayPalsphereClient, Events } from '@paypalsphere/sdk';

async function main() {
  // 1️⃣  Initialize the SDK
  const pps = new PayPalsphereClient({
    clientId:     process.env.PPSPHERE_CLIENT_ID,
    clientSecret: process.env.PPSPHERE_CLIENT_SECRET,
    environment:  process.env.PPSPHERE_ENV, // “sandbox” | “production”
  });

  // 2️⃣  Create a new Circle
  console.info('Creating a new Circle for our ski-trip…');
  const circle = await pps.circle.create({
    name:        'Aspen Ski Trip ❄️',
    description: 'Friends chipping in for lifts, lodge & food',
    currency:    'USD',
    visibility:  'PRIVATE', // public circles are discoverable
    tags:        ['travel', 'friends', 'ski2024'],
  });
  console.log('✅  Circle created:', circle.id);

  // 3️⃣  Invite members – PayPalsphere handles KYC in background
  const emails = ['alex@example.com', 'jamie@example.net'];
  const invitations = await Promise.all(
    emails.map((email) =>
      pps.circle.inviteMember(circle.id, { email, role: 'MEMBER' }),
    ),
  );
  console.log('📨  Invitations sent:', invitations.length);

  // 4️⃣  Subscribe to KYC / Risk events for *this* circle
  pps.events.subscribe({
    scope: Events.Scope.Circle,
    entityId: circle.id,
    types: [
      Events.Type.MemberKycApproved,
      Events.Type.MemberKycDeclined,
      Events.Type.PaymentSettled,
    ],
    handler: (evt) => {
      switch (evt.type) {
        case Events.Type.MemberKycApproved:
          console.log(
            `🪪  KYC approved for member ${evt.payload.memberId}. Ready for payments!`,
          );
          break;
        case Events.Type.MemberKycDeclined:
          console.warn(
            `⚠️  KYC declined for member ${evt.payload.memberId}. Reason:`,
            evt.payload.declineReason,
          );
          break;
        case Events.Type.PaymentSettled:
          console.log('💸  Payment settled:', evt.payload);
          break;
        default:
          console.debug('Unhandled event', evt);
      }
    },
  });

  // 5️⃣  Kick-off first social payment (e.g., reservation deposit)
  const txn = await pps.payment.create({
    circleId:   circle.id,
    amount:     350.0,
    currency:   'USD',
    description: 'Airbnb reservation deposit',
    split: [
      { memberEmail: emails[0], ratio: 0.5 },
      { memberEmail: emails[1], ratio: 0.5 },
    ],
  });
  console.log('⏳  Payment posted, waiting for settlement:', txn.timelineUrl);

  // Done – the user interface (mobile/web) will take it from here!
}

main().catch((err) => {
  console.error('❌  Onboarding failed:', err);
  process.exitCode = 1;
});
```

---

## 4. Webhook Receiver (Express)

Event subscriptions created above are delivered via HTTPS. This receiver verifies the
signature and emits domain events to your internal services.

`src/webhook.js`

```js
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

/**
 * Verify PayPalsphere HMAC header.
 * @returns {boolean}
 */
function verify(req) {
  const signature = req.get('x-ppsphere-signature') ?? '';
  const computed = crypto
    .createHmac('sha256', process.env.PPSPHERE_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(computed, 'utf8'),
  );
}

app.post('/webhooks/paypalsphere', (req, res) => {
  if (!verify(req)) {
    console.warn('⚠️  Invalid webhook signature, dropping request.');
    return res.status(400).send('invalid signature');
  }

  const { type, payload } = req.body;
  console.log(`📡  ${type}`, JSON.stringify(payload, null, 2));

  // TODO: forward into your own event-bus, CQRS pipeline, etc.
  return res.sendStatus(204);
});

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.info(`🚀  Webhook receiver listening on http://0.0.0.0:${PORT}`);
});
```

---

## 5. Next Steps

1. Embed the **PayPalsphere Web Component** in your SPA for an instant social‐feed UI.  
2. Extend the saga workflow with advanced settlement (multi-currency, escrow).  
3. Stream your audit events to a SIEM tool—thanks to **Event Sourcing** everything is immutable.  

Need assistance? Join our Slack: `#dev-paypalsphere` or open an issue on GitHub.

---

© PayPalsphere 2024. All rights reserved.  
Licensed under MIT for SDK samples.
```