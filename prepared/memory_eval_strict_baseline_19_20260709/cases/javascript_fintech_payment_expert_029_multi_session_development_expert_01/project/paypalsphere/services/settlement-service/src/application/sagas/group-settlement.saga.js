```javascript
/**
 * paypalsphere/services/settlement-service/src/application/sagas/group-settlement.saga.js
 *
 * GroupSettlementSaga orchestrates the end-to-end workflow required to
 * settle a group payment request.  The saga coordinates with the following
 * bounded-contexts / micro-services:
 *
 *  • KYC Service          – Validates that every participant is KYC-verified
 *  • Risk Service         – Performs a risk assessment on the transaction
 *  • Compliance Service   – Checks domestic / cross-border compliance rules
 *  • Ledger Service       – Reserves and transfers funds atomically
 *  • Social Graph         – Publishes social feed entries
 *  • Notification Service – Notifies users of status updates
 *
 * On failure, compensating transactions are executed to rollback any partial
 * state mutations (e.g. release reserved funds).
 *
 * NOTE: In production, these operations are dispatched asynchronously over a
 * message broker (Kafka/NATS/RabbitMQ).  For brevity, a lightweight in-process
 * EventBus is used here.
 */

'use strict';

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

// --- Infrastructure -------------------------------------------------------

/**
 * Ultra-thin event-bus abstraction for the purpose of this example.
 * Replace with NATS/Kafka or the platform’s preferred broker.
 */
class EventBus extends EventEmitter {
    publish(eventName, payload) {
        setImmediate(() => this.emit(eventName, payload));
    }
}

const eventBus = new EventBus();

/**
 * Simple in-memory saga repository.  Swap with persistent storage (DynamoDB,
 * Postgres, Mongo, EventStoreDB, …) depending on the deployment topology.
 */
class SagaRepository {
    constructor() {
        this._store = new Map(); // Map<settlementId, SagaState>
    }

    async save(state) {
        this._store.set(state.settlementId, state);
    }

    async find(settlementId) {
        return this._store.get(settlementId);
    }

    async delete(settlementId) {
        this._store.delete(settlementId);
    }
}

const sagaRepository = new SagaRepository();

// --- External Service Gateways -------------------------------------------

/**
 * Each gateway encapsulates a network call to its respective micro-service.
 * Proper circuit-breakers / retries are omitted for brevity.
 */

const kycGateway = {
    async verifyUsers(userIds) {
        // simulate latency & success
        await delay(50);
        return { ok: true, verifiedUserIds: userIds };
    }
};

const riskGateway = {
    async assess(settlement) {
        await delay(50);
        return { ok: true, riskScore: 12 }; // 0–100 scale
    }
};

const complianceGateway = {
    async check(settlement) {
        await delay(50);
        return { ok: true };
    }
};

const ledgerGateway = {
    async reserveFunds(settlement) {
        await delay(50);
        return { ok: true, reservationId: uuidv4() };
    },
    async releaseFunds(reservationId) {
        await delay(50);
        return { ok: true };
    },
    async transferFunds(reservationId) {
        await delay(50);
        return { ok: true, ledgerTxId: uuidv4() };
    }
};

const notificationGateway = {
    async send(to, templateId, context) {
        await delay(10);
        return { ok: true };
    }
};

const socialFeedGateway = {
    async publish(post) {
        await delay(15);
        return { ok: true, postId: uuidv4() };
    }
};

// --- Saga Domain ----------------------------------------------------------

const SAGA_STEPS = Object.freeze({
    INITIATED:           'INITIATED',
    KYC_VERIFIED:        'KYC_VERIFIED',
    RISK_ASSESSED:       'RISK_ASSESSED',
    COMPLIANCE_CHECKED:  'COMPLIANCE_CHECKED',
    FUNDS_RESERVED:      'FUNDS_RESERVED',
    FUNDS_TRANSFERRED:   'FUNDS_TRANSFERRED',
    COMPLETED:           'COMPLETED',
    FAILED:              'FAILED'
});

class SagaState {
    constructor({ settlementId, circleId, createdBy, members, amount, currency }) {
        this.settlementId = settlementId;
        this.circleId     = circleId;
        this.createdBy    = createdBy;
        this.members      = members;
        this.amount       = amount;
        this.currency     = currency;
        this.step         = SAGA_STEPS.INITIATED;
        this.history      = [];
        this.error        = null;

        // resources used during the saga, for compensation
        this._reservationId = null;
    }

    transition(nextStep, meta = {}) {
        this.history.push({
            from: this.step,
            to:   nextStep,
            ts:   Date.now(),
            meta
        });
        this.step = nextStep;
    }
}

/**
 * GroupSettlementSaga
 * Orchestrates the state of a single group settlement.
 */
class GroupSettlementSaga {
    /**
     * Kick-off a new saga instance.
     */
    static async start({ circleId, createdBy, members, amount, currency }) {
        const settlementId = uuidv4();
        const state = new SagaState({
            settlementId,
            circleId,
            createdBy,
            members,
            amount,
            currency
        });

        await sagaRepository.save(state);
        eventBus.publish('SettlementSaga.Initiated', { settlementId });

        return settlementId;
    }

    /**
     * Execute the saga step machine until completion or failure.
     * Because each step may result in an asynchronous domain event from
     * another micro-service, this function can be re-entered idempotently.
     */
    static async continue(settlementId) {
        const state = await sagaRepository.find(settlementId);
        if (!state) throw new Error(`Saga state not found for ${settlementId}`);

        try {
            switch (state.step) {
                case SAGA_STEPS.INITIATED:
                    await this._verifyKyc(state);
                    break;
                case SAGA_STEPS.KYC_VERIFIED:
                    await this._assessRisk(state);
                    break;
                case SAGA_STEPS.RISK_ASSESSED:
                    await this._checkCompliance(state);
                    break;
                case SAGA_STEPS.COMPLIANCE_CHECKED:
                    await this._reserveFunds(state);
                    break;
                case SAGA_STEPS.FUNDS_RESERVED:
                    await this._transferFunds(state);
                    break;
                case SAGA_STEPS.FUNDS_TRANSFERRED:
                    await this._publishSocialPost(state);
                    break;
                default:
                    // No-op if saga is completed/failed
                    break;
            }
        } catch (err) {
            await this._fail(state, err);
        }
    }

    // ------------------------------------------------
    // Step 1: KYC verification
    // ------------------------------------------------
    static async _verifyKyc(state) {
        const res = await kycGateway.verifyUsers(state.members);

        if (res.ok) {
            state.transition(SAGA_STEPS.KYC_VERIFIED, { verifiedUserIds: res.verifiedUserIds });
            await sagaRepository.save(state);
            eventBus.publish('SettlementSaga.KycVerified', { settlementId: state.settlementId });
            return this.continue(state.settlementId);
        }

        throw new Error('KYC verification failed');
    }

    // ------------------------------------------------
    // Step 2: Risk assessment
    // ------------------------------------------------
    static async _assessRisk(state) {
        const res = await riskGateway.assess(state);

        if (res.ok && res.riskScore < 70) {
            state.transition(SAGA_STEPS.RISK_ASSESSED, { riskScore: res.riskScore });
            await sagaRepository.save(state);
            eventBus.publish('SettlementSaga.RiskAssessed', { settlementId: state.settlementId });
            return this.continue(state.settlementId);
        }

        throw new Error(`High risk score ${res.riskScore}`);
    }

    // ------------------------------------------------
    // Step 3: Compliance Screening
    // ------------------------------------------------
    static async _checkCompliance(state) {
        const res = await complianceGateway.check(state);

        if (res.ok) {
            state.transition(SAGA_STEPS.COMPLIANCE_CHECKED);
            await sagaRepository.save(state);
            eventBus.publish('SettlementSaga.ComplianceChecked', { settlementId: state.settlementId });
            return this.continue(state.settlementId);
        }

        throw new Error('Compliance violation');
    }

    // ------------------------------------------------
    // Step 4: Reserve Funds
    // ------------------------------------------------
    static async _reserveFunds(state) {
        const res = await ledgerGateway.reserveFunds(state);

        if (res.ok) {
            state._reservationId = res.reservationId;
            state.transition(SAGA_STEPS.FUNDS_RESERVED, { reservationId: res.reservationId });
            await sagaRepository.save(state);
            eventBus.publish('SettlementSaga.FundsReserved', { settlementId: state.settlementId });
            return this.continue(state.settlementId);
        }

        throw new Error('Unable to reserve funds');
    }

    // ------------------------------------------------
    // Step 5: Transfer Funds
    // ------------------------------------------------
    static async _transferFunds(state) {
        const res = await ledgerGateway.transferFunds(state._reservationId);

        if (res.ok) {
            state.transition(SAGA_STEPS.FUNDS_TRANSFERRED, { ledgerTxId: res.ledgerTxId });
            await sagaRepository.save(state);
            eventBus.publish('SettlementSaga.FundsTransferred', { settlementId: state.settlementId });
            return this.continue(state.settlementId);
        }

        throw new Error('Ledger transfer failed');
    }

    // ------------------------------------------------
    // Step 6: Publish Social Feed & Notify
    // ------------------------------------------------
    static async _publishSocialPost(state) {
        const post = {
            circleId:  state.circleId,
            createdBy: state.createdBy,
            type:      'GROUP_SETTLEMENT',
            payload: {
                amount:   state.amount,
                currency: state.currency,
                members:  state.members
            }
        };

        const res = await socialFeedGateway.publish(post);

        if (res.ok) {
            await Promise.all(
                state.members.map((userId) =>
                    notificationGateway.send(userId, 'GROUP_SETTLEMENT_COMPLETED', {
                        amount:   state.amount,
                        currency: state.currency,
                        circleId: state.circleId
                    })
                )
            );

            state.transition(SAGA_STEPS.COMPLETED, { socialPostId: res.postId });
            await sagaRepository.save(state);
            eventBus.publish('SettlementSaga.Completed', { settlementId: state.settlementId });

            // Cleanup saga state (optional)
            await sagaRepository.delete(state.settlementId);
            return;
        }

        throw new Error('Social post failed');
    }

    // ------------------------------------------------
    // Failure / Compensation
    // ------------------------------------------------
    static async _fail(state, err) {
        state.error = {
            message: err.message,
            stack:   err.stack,
            ts:      Date.now()
        };

        // Compensation: release any reserved funds
        if (state._reservationId) {
            await ledgerGateway.releaseFunds(state._reservationId)
                .catch((e) => {
                    // Swallow compensation errors but log them
                    console.error(
                        '[GroupSettlementSaga] Failed to release reservation',
                        state._reservationId,
                        e.message
                    );
                });
        }

        state.transition(SAGA_STEPS.FAILED);
        await sagaRepository.save(state);
        eventBus.publish('SettlementSaga.Failed', {
            settlementId: state.settlementId,
            error:        state.error
        });

        // Notify initiator about failure
        await notificationGateway.send(
            state.createdBy,
            'GROUP_SETTLEMENT_FAILED',
            { reason: err.message, settlementId: state.settlementId }
        ).catch(() => {/* ignore */});
    }
}

// --- EventBus listeners (idempotent) --------------------------------------
// In a distributed system each of these would be a separate
// service/subscription group.  They are colocated here for clarity.

eventBus.on('SettlementSaga.Initiated', ({ settlementId }) =>
    GroupSettlementSaga.continue(settlementId)
);

eventBus.on('SettlementSaga.KycVerified', ({ settlementId }) =>
    GroupSettlementSaga.continue(settlementId)
);

eventBus.on('SettlementSaga.RiskAssessed', ({ settlementId }) =>
    GroupSettlementSaga.continue(settlementId)
);

eventBus.on('SettlementSaga.ComplianceChecked', ({ settlementId }) =>
    GroupSettlementSaga.continue(settlementId)
);

eventBus.on('SettlementSaga.FundsReserved', ({ settlementId }) =>
    GroupSettlementSaga.continue(settlementId)
);

eventBus.on('SettlementSaga.FundsTransferred', ({ settlementId }) =>
    GroupSettlementSaga.continue(settlementId)
);

// --- Helpers --------------------------------------------------------------

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Exports --------------------------------------------------------------

module.exports = {
    GroupSettlementSaga,
    eventBus,            // exported so other modules can subscribe
    SAGA_STEPS
};
```