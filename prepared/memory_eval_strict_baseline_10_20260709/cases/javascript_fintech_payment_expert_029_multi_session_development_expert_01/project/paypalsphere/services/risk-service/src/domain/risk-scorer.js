```javascript
'use strict';

/**
 * PayPalsphere – Risk Service
 * File: src/domain/risk-scorer.js
 *
 * Centralised risk–scoring engine used by the Risk-Service command-side to enrich
 * transaction and onboarding commands before they are persisted as events.
 *
 * The scorer is intentionally *pure* (no persistence) so that it can be safely
 * re-executed during event-replay without side-effects.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * External Deps                                                             *
 * ────────────────────────────────────────────────────────────────────────── */
const axios = require('axios').default;
const LRU = require('lru-cache');
const pino = require('pino');
const { DateTime } = require('luxon');
const _ = require('lodash');

/* ────────────────────────────────────────────────────────────────────────── *
 * Configuration                                                             *
 * ────────────────────────────────────────────────────────────────────────── */
const cfg = {
  endpoints: {
    sanctions: process.env.SANCTIONS_API || 'https://sanctions.api/screen',
    socialTrust: process.env.SOCIAL_GRAPH_API || 'http://social-graph/api/v1/trust',
    deviceIntel: process.env.DEVICE_INTEL_API || 'https://device-intel/api/v2/score'
  },
  cacheTtlSeconds: Number(process.env.RISK_CACHE_TTL_SEC) || 900,
  weights: {
    kycCompletion: 0.15,
    sanctionsScreen: 0.25,
    paymentVelocity: 0.20,
    geoVelocity: 0.15,
    deviceConsistency: 0.15,
    socialTrust: 0.10
  },
  // Risk versions make historical audits explicit.
  modelVersion: '2023.11.0'
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Init global cache + logger                                                *
 * ────────────────────────────────────────────────────────────────────────── */
const cache = new LRU({
  max: 5000,
  ttl: cfg.cacheTtlSeconds * 1000
});

const logger = pino({
  name: 'risk-scorer',
  level: process.env.LOG_LEVEL || 'info'
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Utility helpers                                                           *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a bucket label for a numeric score (0-100).
 * @param {number} score
 */
function bucketize(score) {
  if (score >= 75) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  return 'LOW';
}

/**
 * Creates a cancellable Axios request with timeouts enforced.
 */
async function safeGet(url, opts = {}) {
  try {
    return await axios.get(url, { timeout: 4000, ...opts });
  } catch (err) {
    logger.warn({ msg: 'Upstream call failed', url, err: err.message });
    throw new Error(`Upstream call (${url}) failed`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Individual signal evaluators                                              *
 * Each evaluator returns a score between 0 (no-risk) ‑ 100 (high-risk).     *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * KYC Completion evaluator
 */
async function evaluateKycCompletion({ kycStatus }) {
  // Fully verified → 0, partially 40, none 90
  if (kycStatus === 'VERIFIED') return 0;
  if (kycStatus === 'PARTIAL') return 40;
  return 90;
}

/**
 * Sanctions screening evaluator
 */
async function evaluateSanctions({ fullName, dateOfBirth }) {
  const cacheKey = `sanctions:${fullName}:${dateOfBirth}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  /* istanbul ignore next */
  const url = `${cfg.endpoints.sanctions}?name=${encodeURIComponent(
    fullName
  )}&dob=${dateOfBirth}`;

  const { data } = await safeGet(url);
  // API returns matchScore 0-1 → scale to 0-100.
  const score = Math.round(_.clamp(data.matchScore, 0, 1) * 100);

  cache.set(cacheKey, score);
  return score;
}

/**
 * Payment velocity (how many tx in the last X minutes?)
 */
async function evaluatePaymentVelocity({ recentPayments }) {
  // naive implementation: >10 payments in 30 mins → risky
  const now = DateTime.utc();
  const last30m = recentPayments.filter(tx =>
    DateTime.fromISO(tx.timestamp).plus({ minutes: 30 }) > now
  );

  if (last30m.length <= 3) return 10;
  if (last30m.length <= 10) return 40;
  return 80; // velocity spike
}

/**
 * Geo velocity evaluator – distance between last two geo locations
 */
async function evaluateGeoVelocity({ lastGeo, currentGeo }) {
  if (!lastGeo || !currentGeo) return 20; // unable to compare
  const kmDistance = haversineKm(lastGeo, currentGeo);
  // >2500km apart within 2h is suspicious
  const hoursDiff = Math.abs(
    DateTime.fromISO(currentGeo.timestamp)
      .diff(DateTime.fromISO(lastGeo.timestamp), 'hours')
      .hours
  );

  if (hoursDiff === 0) return 90; // same timestamp, clearly impossible
  const kmPerH = kmDistance / hoursDiff;
  if (kmPerH < 800) return 10; // plausible
  if (kmPerH < 1500) return 40;
  return 85;
}

/**
 * Device consistency evaluator – diff device fingerprint
 */
async function evaluateDeviceConsistency({ userId, deviceFingerprint }) {
  const cacheKey = `device:${userId}`;
  const known = cache.get(cacheKey);

  if (!known) {
    cache.set(cacheKey, deviceFingerprint);
    return 10;
  }

  const match = fuzzCompareFingerprint(known, deviceFingerprint);

  if (match >= 0.9) return 15; // same device
  if (match >= 0.6) return 45; // similar
  return 80; // new device
}

/**
 * Social trust score (how reputable are friends/circles?)
 */
async function evaluateSocialTrust({ userId }) {
  const cacheKey = `socialTrust:${userId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  /* istanbul ignore next */
  const url = `${cfg.endpoints.socialTrust}/${userId}`;
  const { data } = await safeGet(url);
  // service returns trustScore 0-1 → reverse to risk (1-score)
  const score = Math.round((1 - data.trustScore) * 100);

  cache.set(cacheKey, score);
  return score;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Risk Scorer Facade                                                        *
 * ────────────────────────────────────────────────────────────────────────── */

class RiskScorer {
  /**
   * Calculates aggregated risk for given context.
   * @param {RiskContext} ctx
   * @return {Promise<RiskScore>}
   */
  async score(ctx) {
    // Run evaluators in parallel
    const [
      kyc,
      sanctions,
      velocity,
      geo,
      device,
      social
    ] = await Promise.all([
      evaluateKycCompletion(ctx),
      evaluateSanctions(ctx),
      evaluatePaymentVelocity(ctx),
      evaluateGeoVelocity(ctx),
      evaluateDeviceConsistency(ctx),
      evaluateSocialTrust(ctx)
    ]);

    // Weighted average
    const weighted =
      cfg.weights.kycCompletion * kyc +
      cfg.weights.sanctionsScreen * sanctions +
      cfg.weights.paymentVelocity * velocity +
      cfg.weights.geoVelocity * geo +
      cfg.weights.deviceConsistency * device +
      cfg.weights.socialTrust * social;

    const score = Math.round(weighted);
    const risk = {
      score,
      bucket: bucketize(score),
      version: cfg.modelVersion,
      reasons: {
        kyc,
        sanctions,
        velocity,
        geo,
        device,
        social
      }
    };

    logger.debug({ msg: 'Risk computed', risk, userId: ctx.userId });

    return risk;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Helper Functions                                                          *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Rough haversine distance in KM.
 */
function haversineKm(a, b) {
  const rad = deg => (deg * Math.PI) / 180;
  const R = 6371; // km
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);

  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(hav));
}

/**
 * Very naive fingerprint comparison → returns [0,1]
 */
function fuzzCompareFingerprint(a, b) {
  if (!a || !b) return 0;
  const overlap = _.intersection(Object.keys(a), Object.keys(b)).filter(
    key => a[key] === b[key]
  ).length;
  const union = _.union(Object.keys(a), Object.keys(b)).length;
  return union === 0 ? 0 : overlap / union;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Type Definitions (JSDoc)                                                  *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} RiskContext
 * @property {string} userId
 * @property {('VERIFIED'|'PARTIAL'|'NONE')} kycStatus
 * @property {string} fullName
 * @property {string} dateOfBirth             ISO Date YYYY-MM-DD
 * @property {Object[]} recentPayments        Array<{ timestamp: ISO8601 }>
 * @property {Object} lastGeo                 { lat, lon, timestamp }
 * @property {Object} currentGeo              { lat, lon, timestamp }
 * @property {Object} deviceFingerprint       Arbitrary key/value map
 */

/**
 * @typedef {Object} RiskScore
 * @property {number} score                 0-100 (higher == riskier)
 * @property {'LOW'|'MEDIUM'|'HIGH'} bucket
 * @property {string} version               Model version
 * @property {Object} reasons               Raw per-signal scores
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Exports                                                                   *
 * ────────────────────────────────────────────────────────────────────────── */

module.exports = new RiskScorer();
```