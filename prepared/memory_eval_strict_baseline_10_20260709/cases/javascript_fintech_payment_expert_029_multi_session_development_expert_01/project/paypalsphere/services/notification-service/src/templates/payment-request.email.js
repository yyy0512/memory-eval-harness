/**
 * PayPalsphere – Notification Service
 * ------------------------------------
 * Email template generator: PAYMENT REQUEST
 *
 *  This module is responsible for generating the subject line, HTML markup,
 *  and plaintext body for “payment‐request” notifications.  A payment‐request
 *  notification is dispatched every time a user (the “requestor”) asks one or
 *  several peers (the “payer”) for funds inside a Circle timeline.
 *
 *  Key design considerations:
 *  • Security/Injection‐safety  –  All dynamic content is escaped.
 *  • i18n / l10n                 –  Minimal multilingual support (en-US | es-ES).
 *  • Currency / Date formatting  –  Uses built-in Intl API + date-fns.
 *  • Configurability             –  Branded assets & host enriched via ENV.
 *
 *  @module templates/payment-request.email
 */

import escapeHtml from 'escape-html';
import { format } from 'date-fns';
import { enUS, es } from 'date-fns/locale';

/**
 * Resolve environment–driven assets.
 */
const APP_BRAND_NAME        = process.env.APP_BRAND_NAME        || 'PayPalsphere';
const APP_BRAND_PRIMARY_CLR = process.env.APP_PRIMARY_COLOR     || '#0070E0';
const APP_BRAND_LOGO_URL    = process.env.APP_LOGO_URL          || 'https://assets.paypalsphere.com/logo-full.png';
const APP_PUBLIC_HOST       = process.env.APP_PUBLIC_HOST       || 'https://app.paypalsphere.com';

/**
 * Lightweight i18n dictionary (extend as needed).
 */
const I18N = {
  'en-US': {
    subject:      (name) => `${name} requested a payment on ${APP_BRAND_NAME}`,
    greeting:     (name) => `Hi ${name},`,
    headline:     (requestor, circle) =>
      `${requestor} posted a new payment request${circle ? ` in <em>${circle}</em>` : ''}.`,
    amountLabel:  'Amount',
    dueLabel:     'Due by',
    payCta:       'Review & Pay',
    disclaimer:   'You are receiving this email because you are a member of a circle on PayPalsphere.',
  },
  'es-ES': {
    subject:      (name) => `${name} solicitó un pago en ${APP_BRAND_NAME}`,
    greeting:     (name) => `Hola ${name},`,
    headline:     (requestor, circle) =>
      `${requestor} publicó una nueva solicitud de pago${circle ? ` en <em>${circle}</em>` : ''}.`,
    amountLabel:  'Importe',
    dueLabel:     'Fecha límite',
    payCta:       'Revisar y pagar',
    disclaimer:   'Recibes este correo porque eres miembro de un círculo en PayPalsphere.',
  },
};

/**
 * Select date-fns locale object by language tag.
 * @param {string} localeTag
 * @returns {import('date-fns').Locale}
 */
const resolveDateFnsLocale = (localeTag) => {
  switch (localeTag) {
    case 'es-ES':
      return es;
    case 'en-US':
    default:
      return enUS;
  }
};

/**
 * Escape AND truncate strings to mitigate abuse vectors in email clients.
 * @param {string} value Raw value
 * @param {number} [maxLen=90] Max length
 */
const sanitize = (value, maxLen = 90) =>
  escapeHtml(String(value).trim().slice(0, maxLen));

/**
 * Format monetary value using Intl.
 * @param {number|string} amount Amount in currency’s minor unit (e.g. cents)
 * @param {string} currency ISO-4217
 * @param {string} locale   BCP-47
 */
const formatCurrency = (amount, currency, locale) => {
  const number = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
};

/**
 * Payment Request Email Builder
 * --------------------------------------------------------------------------
 * @param {object}  params
 * @param {string}  params.recipientName   – Display name of the recipient
 * @param {string}  params.requestorName   – Name of the user requesting payment
 * @param {number}  params.amount          – Requested amount (major unit)
 * @param {string}  params.currency        – ISO currency code
 * @param {string}  [params.circleName]    – Optional circle name
 * @param {Date}    [params.dueDate]       – Optional due date
 * @param {string}  params.requestId       – UUID of the payment request
 * @param {string}  [params.locale=en-US]  – Recipient’s locale
 * @returns {{subject:string, html:string, text:string}}
 */
export const buildPaymentRequestEmail = ({
  recipientName,
  requestorName,
  amount,
  currency,
  circleName,
  dueDate,
  requestId,
  locale = 'en-US',
}) => {
  // Defensive programing: ensure we have a supported locale
  const i18n = I18N[locale] || I18N['en-US'];

  // ─── Dynamic pieces (sanitized) ───────────────────────────────────────────
  const safeRecipient = sanitize(recipientName || '');
  const safeRequestor = sanitize(requestorName || 'Someone');
  const safeCircle    = circleName ? sanitize(circleName) : null;

  // ─── Derived, formatted pieces ────────────────────────────────────────────
  const currencyStr = formatCurrency(amount, currency, locale);
  const dueDateStr  = dueDate
    ? format(dueDate, 'PPP', { locale: resolveDateFnsLocale(locale) })
    : null;

  const payUrl = `${APP_PUBLIC_HOST}/pay/${encodeURIComponent(requestId)}`;

  // ─── Build plaintext body (fallback) ──────────────────────────────────────
  const textBodyLines = [
    i18n.greeting(safeRecipient),
    '',
    i18n.headline(safeRequestor, safeCircle ? `"${safeCircle}"` : ''),
    `${i18n.amountLabel}: ${currencyStr}`,
    dueDateStr ? `${i18n.dueLabel}: ${dueDateStr}` : '',
    '',
    `${i18n.payCta}: ${payUrl}`,
    '',
    '--',
    i18n.disclaimer,
  ].filter(Boolean); // Remove empty lines

  const textBody = textBodyLines.join('\n');

  // ─── Build HTML body ──────────────────────────────────────────────────────
  const htmlBody = /* html */ `
    <!DOCTYPE html>
    <html lang="${locale}">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(i18n.subject(safeRequestor))}</title>
        <style>
          /* Embeddable styles safe for most major clients */
          body { margin:0; padding:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f5f7fa; color:#333; }
          .container { max-width:600px; margin:0 auto; padding:24px; background:#ffffff; }
          .header img { height:40px; }
          h1 { color:${APP_BRAND_PRIMARY_CLR}; font-size:20px; margin:24px 0 8px; }
          .amount { font-size:24px; font-weight:600; color:#000; }
          .button {
            display:inline-block; margin:32px 0; padding:16px 32px;
            background:${APP_BRAND_PRIMARY_CLR}; color:#ffffff; text-decoration:none; border-radius:4px;
            font-weight:600;
          }
          .meta { font-size:14px; color:#555; margin:8px 0; }
          .footer { font-size:12px; color:#999; margin-top:48px; text-align:center; }
          @media (prefers-color-scheme: dark) {
            body { background:#111827; color:#e5e7eb; }
            .container { background:#1f2937; }
            .amount { color:#fff; }
            .button { background:#3b82f6; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="${APP_PUBLIC_HOST}"><img src="${APP_BRAND_LOGO_URL}" alt="${APP_BRAND_NAME} logo"></a>
          </div>

          <p>${i18n.greeting(safeRecipient)}</p>

          <h1>${i18n.headline(safeRequestor, safeCircle)}</h1>

          <p class="amount">${currencyStr}</p>
          ${
            dueDateStr
              ? `<p class="meta"><strong>${i18n.dueLabel}:</strong> ${dueDateStr}</p>`
              : ''
          }

          <a href="${payUrl}" class="button">${i18n.payCta}</a>

          <p class="footer">${i18n.disclaimer}<br>
          © ${new Date().getFullYear()} ${APP_BRAND_NAME}</p>
        </div>
      </body>
    </html>
  `;

  return {
    subject: i18n.subject(safeRequestor),
    html: htmlBody,
    text: textBody,
  };
};

/* c8 ignore next */
/**
 * If this file is executed directly (debug), dump a sample template.
 * `node payment-request.email.js`
 */
if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(
    buildPaymentRequestEmail({
      recipientName: 'Alice',
      requestorName: 'Bob',
      amount: 42.75,
      currency: 'USD',
      circleName: 'Weekend Trip',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
      requestId: 'deadbeef-42',
      locale: 'en-US',
    })
  );
}