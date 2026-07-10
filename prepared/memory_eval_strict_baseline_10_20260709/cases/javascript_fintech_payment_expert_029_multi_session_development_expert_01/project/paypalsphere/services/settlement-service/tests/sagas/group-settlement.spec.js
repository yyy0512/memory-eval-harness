/**
 * @fileoverview
 * Unit-tests for the Group-Settlement Saga that orchestrates the multi-step
 * settlement flow between members of a circle.  The saga coordinates the
 * following (mocked) domain services:
 *
 *   1. KYC Service          → verify the initiating user.
 *   2. Risk Service         → score the transaction.
 *   3. FX/Currency Service  → convert multi-currency amounts if required.
 *   4. Payment Gateway      → perform the actual money movement.
 *   5. Audit Trail Service  → immutable logging for compliance.
 *   6. Notification Service → fan-out realtime updates to circle members.
 *
 * A successful saga should dispatch the appropriate domain events and
 * compensate gracefully on failure, emitting a SETTLEMENT_FAILED_* action.
 *
 * The saga lives at:
 *   services/settlement-service/src/sagas/group-settlement.js
 *
 * These tests rely on `redux-saga`’s `runSaga` helper rather than
 * `redux-saga-test-plan` to avoid implicating additional test-only
 * dependencies while still exercising the generator’s full control flow.
 */

import { runSaga } from 'redux-saga';
import groupSettlementSaga from '../../src/sagas/group-settlement';
import {
  GROUP_SETTLEMENT_REQUESTED,
  GROUP_SETTLEMENT_SUCCEEDED,
  GROUP_SETTLEMENT_FAILED,
  SETTLEMENT_STAGE_KYC,
  SETTLEMENT_STAGE_RISK,
  SETTLEMENT_STAGE_PAYMENT,
} from '../../src/actions/types';
import * as KycService from '../../src/services/kyc-service';
import * as RiskService from '../../src/services/risk-service';
import * as CurrencyService from '../../src/services/currency-service';
import * as PaymentGateway from '../../src/services/payment-gateway';
import * as AuditTrailService from '../../src/services/audit-trail-service';
import * as NotificationService from '../../src/services/notification-service';

// ---------------------------------------------------------------------------
// Jest mocks – override actual implementations with controllable stubs.
// ---------------------------------------------------------------------------
jest.mock('../../src/services/kyc-service');
jest.mock('../../src/services/risk-service');
jest.mock('../../src/services/currency-service');
jest.mock('../../src/services/payment-gateway');
jest.mock('../../src/services/audit-trail-service');
jest.mock('../../src/services/notification-service');

describe('Group Settlement Saga', () => {
  const circleId = 'cir_123456789';
  const settlementId = 'set_987654321';
  const initiatorId = 'usr_john_doe';
  const requestPayload = {
    type: GROUP_SETTLEMENT_REQUESTED,
    payload: {
      settlementId,
      circleId,
      initiatorId,
      amounts: [
        /* crypto or fiat, supports multi-currency  */
        { payerId: 'usr_john_doe', amount: 50, currency: 'USD' },
        { payerId: 'usr_jane_doe', amount: 55, currency: 'EUR' },
      ],
      memo: 'Barcelona dinner – Tapas & drinks 🍻',
    },
  };

  let dispatched; // captures saga .dispatch calls per test case

  /**
   * Utility helper to invoke the saga under test.
   */
  const run = async (action = requestPayload) => {
    dispatched = [];
    await runSaga(
      {
        dispatch: (output) => dispatched.push(output),
        getState: () => ({}), // no need for store state within current scope
      },
      groupSettlementSaga,
      action,
    ).toPromise();
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // SUCCESS FLOW
  // -------------------------------------------------------------------------
  it('settles successfully through the happy-path', async () => {
    // Arrange – configure mocks to resolve successfully.
    KycService.verify.mockResolvedValue({ status: 'VERIFIED' });
    RiskService.score.mockResolvedValue({ score: 12 }); // low risk
    CurrencyService.maybeConvert.mockResolvedValue([
      { payerId: 'usr_john_doe', amount: 50, currency: 'USD' }, // unchanged
      { payerId: 'usr_jane_doe', amount: 60.11, currency: 'USD' }, // converted
    ]);
    PaymentGateway.settleGroup.mockResolvedValue({
      ledgerTxIds: ['ld_tx_01', 'ld_tx_02'],
    });
    AuditTrailService.record.mockResolvedValue({ traceId: 'audit_123' });
    NotificationService.send.mockResolvedValue(true);

    // Act
    await run();

    // Assert – validate the saga dispatched expected events in order.
    expect(dispatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: `${GROUP_SETTLEMENT_REQUESTED}/STAGE`,
          meta: { stage: SETTLEMENT_STAGE_KYC, status: 'PASSED' },
        }),
        expect.objectContaining({
          type: `${GROUP_SETTLEMENT_REQUESTED}/STAGE`,
          meta: { stage: SETTLEMENT_STAGE_RISK, status: 'PASSED' },
        }),
        expect.objectContaining({
          type: `${GROUP_SETTLEMENT_REQUESTED}/STAGE`,
          meta: { stage: SETTLEMENT_STAGE_PAYMENT, status: 'PASSED' },
        }),
        expect.objectContaining({ type: GROUP_SETTLEMENT_SUCCEEDED }),
      ]),
    );

    // And – the domain services have been invoked exactly once.
    expect(KycService.verify).toHaveBeenCalledTimes(1);
    expect(RiskService.score).toHaveBeenCalledTimes(1);
    expect(CurrencyService.maybeConvert).toHaveBeenCalledTimes(1);
    expect(PaymentGateway.settleGroup).toHaveBeenCalledTimes(1);
    expect(AuditTrailService.record).toHaveBeenCalledTimes(1);
    expect(NotificationService.send).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // FAILURE SCENARIOS
  // -------------------------------------------------------------------------
  it('rejects settlement when KYC fails', async () => {
    // Arrange – KYCS fails by throwing a domain-specific error.
    const kycError = new Error('KYC_NOT_VERIFIED');
    KycService.verify.mockRejectedValue(kycError);

    // Act
    await run();

    // Assert – should dispatch the failed action with proper reason.
    const failedAction = dispatched.find(
      (a) => a.type === GROUP_SETTLEMENT_FAILED,
    );

    expect(failedAction).toBeDefined();
    expect(failedAction.payload.reason).toBe('KYC_FAILURE');
    expect(failedAction.error).toBe(true);

    // Ensure no further downstream services are touched.
    expect(RiskService.score).not.toHaveBeenCalled();
    expect(PaymentGateway.settleGroup).not.toHaveBeenCalled();
  });

  it('compensates when risk score exceeds threshold', async () => {
    // Arrange
    KycService.verify.mockResolvedValue({ status: 'VERIFIED' });
    RiskService.score.mockResolvedValue({ score: 87 }); // high risk
    // risk above threshold leads saga to abort before payment
    CurrencyService.maybeConvert.mockResolvedValue([]);
    PaymentGateway.settleGroup.mockResolvedValue({}); // should not be hit

    // Act
    await run();

    const failedAction = dispatched.find(
      (a) => a.type === GROUP_SETTLEMENT_FAILED,
    );

    expect(failedAction).toBeDefined();
    expect(failedAction.payload.reason).toBe('HIGH_RISK');
    expect(CurrencyService.maybeConvert).not.toHaveBeenCalled();
    expect(PaymentGateway.settleGroup).not.toHaveBeenCalled();
  });

  it('issues compensating refund when payment gateway errors', async () => {
    // Arrange
    KycService.verify.mockResolvedValue({ status: 'VERIFIED' });
    RiskService.score.mockResolvedValue({ score: 5 });
    CurrencyService.maybeConvert.mockResolvedValue(requestPayload.payload.amounts);

    const pgError = Object.assign(new Error('BANK_NETWORK_DOWN'), {
      code: 'PG_COMMUNICATION_FAILURE',
    });
    PaymentGateway.settleGroup.mockRejectedValue(pgError);

    // Act
    await run();

    const failedAction = dispatched.find(
      (a) => a.type === GROUP_SETTLEMENT_FAILED,
    );

    expect(failedAction).toBeDefined();
    expect(failedAction.payload.reason).toBe('PAYMENT_GATEWAY_ERROR');

    // The saga should attempt to record the failure in audit trail even on error.
    expect(AuditTrailService.record).toHaveBeenCalledTimes(1);

    // Optionally ensure comp-transactions are triggered
    // (Assuming `PaymentGateway.compensateGroup` is called on failure)
    expect(PaymentGateway.compensateGroup).toHaveBeenCalledWith(settlementId);
  });
});