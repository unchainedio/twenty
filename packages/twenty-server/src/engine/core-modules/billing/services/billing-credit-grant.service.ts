/* @license Enterprise */

import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';
import { In, IsNull, LessThan, MoreThan } from 'typeorm';

import {
  BillingException,
  BillingExceptionCode,
} from 'src/engine/core-modules/billing/billing.exception';
import { BillingCreditGrantEntity } from 'src/engine/core-modules/billing/entities/billing-credit-grant.entity';
import { BillingCustomerEntity } from 'src/engine/core-modules/billing/entities/billing-customer.entity';
import { type BillingCreditGrantType } from 'src/engine/core-modules/billing/enums/billing-credit-grant-type.enum';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';

const POSTGRES_UNIQUE_VIOLATION_CODE = '23505';

export type CreateBillingCreditGrantParams = {
  workspaceId: string;
  amountMicro: number;
  type: BillingCreditGrantType;
  effectiveAt: Date;
  expiresAt: Date;
  reason?: string | null;
  grantedByUserId?: string | null;
  idempotencyKey?: string | null;
  sourceGrantId?: string | null;
  metadata?: Record<string, string>;
};

const isUniqueViolation = (error: unknown): boolean =>
  isDefined(error) &&
  typeof error === 'object' &&
  ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE ||
    (error as { driverError?: { code?: string } }).driverError?.code ===
      POSTGRES_UNIQUE_VIOLATION_CODE);

// Owns the billingCreditGrant table. Deliberately free of side effects so that
// read paths (available credits) can depend on it without pulling in the cache
// and subscription services that BillingCreditService needs.
@Injectable()
export class BillingCreditGrantService {
  constructor(
    @InjectWorkspaceScopedRepository(BillingCreditGrantEntity)
    private readonly billingCreditGrantRepository: WorkspaceScopedRepository<BillingCreditGrantEntity>,
    @InjectWorkspaceScopedRepository(BillingCustomerEntity)
    private readonly billingCustomerRepository: WorkspaceScopedRepository<BillingCustomerEntity>,
  ) {}

  // Returns null when idempotencyKey has already been used, so callers can tell
  // a fresh grant from a replayed one.
  async createGrant(
    params: CreateBillingCreditGrantParams,
  ): Promise<BillingCreditGrantEntity | null> {
    const {
      workspaceId,
      amountMicro,
      type,
      effectiveAt,
      expiresAt,
      reason = null,
      grantedByUserId = null,
      idempotencyKey = null,
      sourceGrantId = null,
      metadata = {},
    } = params;

    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
      throw new BillingException(
        `Cannot grant an amount (${amountMicro}) that is not a positive safe integer to workspace ${workspaceId}`,
        BillingExceptionCode.BILLING_CREDIT_AMOUNT_INVALID,
      );
    }

    if (expiresAt.getTime() <= effectiveAt.getTime()) {
      throw new BillingException(
        `Cannot grant credits to workspace ${workspaceId} expiring at ${expiresAt.toISOString()}, before or when they become effective at ${effectiveAt.toISOString()}`,
        BillingExceptionCode.BILLING_CREDIT_GRANT_VALIDITY_INVALID,
      );
    }

    try {
      const { identifiers, generatedMaps } =
        await this.billingCreditGrantRepository.insert(workspaceId, {
          amountMicro,
          type,
          effectiveAt,
          expiresAt,
          reason,
          grantedByUserId,
          idempotencyKey,
          sourceGrantId,
          metadata,
        });

      const grantId = (identifiers[0]?.id ?? generatedMaps[0]?.id) as
        | string
        | undefined;

      if (!isDefined(grantId)) {
        return null;
      }

      return this.billingCreditGrantRepository.findOne(workspaceId, {
        where: { id: grantId },
      });
    } catch (error) {
      if (isDefined(idempotencyKey) && isUniqueViolation(error)) {
        return null;
      }

      throw error;
    }
  }

  async getActiveCreditsMicro(
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<number> {
    const result = await this.billingCreditGrantRepository
      .createQueryBuilder('billingCreditGrant')
      .select('COALESCE(SUM("billingCreditGrant"."amountMicro"), 0)', 'total')
      .where('"billingCreditGrant"."workspaceId" = :workspaceId', {
        workspaceId,
      })
      .andWhere('"billingCreditGrant"."revokedAt" IS NULL')
      .andWhere('"billingCreditGrant"."effectiveAt" <= :at', { at })
      .andWhere('"billingCreditGrant"."expiresAt" > :at', { at })
      .getRawOne<{ total: string | number | null }>();

    const total = Number(result?.total ?? 0);

    // Rounding a balance would hand out or withhold credits that were never
    // granted, so refuse rather than serve a number we cannot represent.
    if (!Number.isSafeInteger(total)) {
      throw new BillingException(
        `Credit balance for workspace ${workspaceId} is not a safe integer (${total})`,
        BillingExceptionCode.BILLING_CREDIT_AMOUNT_INVALID,
      );
    }

    return total;
  }

  // What a workspace can actually spend, which is the ledger except in the
  // window between this release deploying and its backfill running: until a
  // workspace has any grant at all, its balance still only exists in the
  // mirror column. Remove this along with creditBalanceMicro.
  async getSpendableCreditsMicro(
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<number> {
    const hasAnyGrant = await this.billingCreditGrantRepository.exists(
      workspaceId,
      { where: {} },
    );

    if (hasAnyGrant) {
      return this.getActiveCreditsMicro(workspaceId, at);
    }

    const billingCustomer = await this.billingCustomerRepository.findOne(
      workspaceId,
      { select: { creditBalanceMicro: true }, where: {} },
    );

    return billingCustomer?.creditBalanceMicro ?? 0;
  }

  // Grants that were spendable at any point during the given period.
  async findGrantsLiveDuringPeriod({
    workspaceId,
    periodStart,
    periodEnd,
  }: {
    workspaceId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<BillingCreditGrantEntity[]> {
    return this.billingCreditGrantRepository.find(workspaceId, {
      where: {
        revokedAt: IsNull(),
        effectiveAt: LessThan(periodEnd),
        expiresAt: MoreThan(periodStart),
      },
      order: { createdAt: 'ASC' },
    });
  }

  // Enforces the one-grant-per-period invariant at the point where periods
  // actually roll: whatever a writer guessed for expiresAt, a grant never
  // outlives the period it was carried forward from.
  async closeGrantsAtPeriodEnd({
    workspaceId,
    grantIds,
    periodEnd,
  }: {
    workspaceId: string;
    grantIds: string[];
    periodEnd: Date;
  }): Promise<void> {
    if (grantIds.length === 0) {
      return;
    }

    await this.billingCreditGrantRepository.update(
      workspaceId,
      { id: In(grantIds), expiresAt: MoreThan(periodEnd) },
      { expiresAt: periodEnd },
    );
  }

  async listGrants(workspaceId: string): Promise<BillingCreditGrantEntity[]> {
    return this.billingCreditGrantRepository.find(workspaceId, {
      order: { createdAt: 'DESC' },
    });
  }

  // wasRevokedNow tells a retried revocation apart from the one that actually
  // took the credits away, so callers only adjust balances once.
  async revokeGrant({
    workspaceId,
    grantId,
    revokedByUserId,
  }: {
    workspaceId: string;
    grantId: string;
    revokedByUserId?: string | null;
  }): Promise<{ grant: BillingCreditGrantEntity; wasRevokedNow: boolean }> {
    const grant = await this.billingCreditGrantRepository.findOne(workspaceId, {
      where: { id: grantId },
    });

    if (!isDefined(grant)) {
      throw new BillingException(
        `Credit grant ${grantId} not found for workspace ${workspaceId}`,
        BillingExceptionCode.BILLING_CREDIT_GRANT_NOT_FOUND,
      );
    }

    if (isDefined(grant.revokedAt)) {
      return { grant, wasRevokedNow: false };
    }

    const { affected } = await this.billingCreditGrantRepository.update(
      workspaceId,
      { id: grantId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedByUserId: revokedByUserId ?? null },
    );

    const revokedGrant = await this.billingCreditGrantRepository.findOneOrFail(
      workspaceId,
      { where: { id: grantId } },
    );

    // Two concurrent revocations both read an unrevoked grant; only the one
    // whose UPDATE matched may move the balance.
    return {
      grant: revokedGrant,
      wasRevokedNow: isDefined(affected) && affected > 0,
    };
  }
}
