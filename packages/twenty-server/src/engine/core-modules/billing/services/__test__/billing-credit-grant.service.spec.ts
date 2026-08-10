/* @license Enterprise */

import { Test, type TestingModule } from '@nestjs/testing';

import { BillingException } from 'src/engine/core-modules/billing/billing.exception';
import { BillingCreditGrantEntity } from 'src/engine/core-modules/billing/entities/billing-credit-grant.entity';
import { BillingCreditGrantType } from 'src/engine/core-modules/billing/enums/billing-credit-grant-type.enum';
import { BillingCreditGrantService } from 'src/engine/core-modules/billing/services/billing-credit-grant.service';
import { getWorkspaceScopedRepositoryToken } from 'src/engine/twenty-orm/workspace-scoped-repository/get-workspace-scoped-repository-token.util';

const workspaceId = 'ws_123';
const EFFECTIVE_AT = new Date('2026-01-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-02-01T00:00:00.000Z');

const validParams = {
  workspaceId,
  amountMicro: 2_000_000,
  type: BillingCreditGrantType.COMPENSATION,
  effectiveAt: EFFECTIVE_AT,
  expiresAt: EXPIRES_AT,
};

describe('BillingCreditGrantService', () => {
  let service: BillingCreditGrantService;
  let repository: jest.Mocked<{
    insert: jest.Mock;
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  }>;
  let queryBuilder: { getRawOne: jest.Mock } & Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilder = {
      select: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getRawOne: jest.fn().mockResolvedValue({ total: '3000000' }),
    };
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingCreditGrantService,
        {
          provide: getWorkspaceScopedRepositoryToken(BillingCreditGrantEntity),
          useValue: {
            insert: jest.fn().mockResolvedValue({
              identifiers: [{ id: 'grant_1' }],
              generatedMaps: [{ id: 'grant_1' }],
            }),
            findOne: jest.fn().mockResolvedValue({ id: 'grant_1' }),
            findOneOrFail: jest
              .fn()
              .mockResolvedValue({ id: 'grant_1', revokedAt: new Date() }),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get<BillingCreditGrantService>(BillingCreditGrantService);
    repository = module.get(
      getWorkspaceScopedRepositoryToken(BillingCreditGrantEntity),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createGrant', () => {
    it('inserts the grant and returns it', async () => {
      const grant = await service.createGrant(validParams);

      expect(repository.insert).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({
          amountMicro: 2_000_000,
          type: BillingCreditGrantType.COMPENSATION,
          effectiveAt: EFFECTIVE_AT,
          expiresAt: EXPIRES_AT,
        }),
      );
      expect(grant).toEqual({ id: 'grant_1' });
    });

    it.each([
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])(
      'throws on a non-positive, non-integer or unsafe-integer amount (%p)',
      async (amountMicro) => {
        await expect(
          service.createGrant({ ...validParams, amountMicro }),
        ).rejects.toThrow(BillingException);

        expect(repository.insert).not.toHaveBeenCalled();
      },
    );

    it('throws when the grant would expire before it becomes effective', async () => {
      await expect(
        service.createGrant({
          ...validParams,
          effectiveAt: EXPIRES_AT,
          expiresAt: EFFECTIVE_AT,
        }),
      ).rejects.toThrow(BillingException);

      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('returns null instead of duplicating a grant with a used idempotency key', async () => {
      repository.insert.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      const grant = await service.createGrant({
        ...validParams,
        idempotencyKey: 'onboarding-import-contacts:ws_123',
      });

      expect(grant).toBeNull();
    });

    it('rethrows a unique violation when no idempotency key was given', async () => {
      repository.insert.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      await expect(service.createGrant(validParams)).rejects.toThrow(
        'duplicate key',
      );
    });

    it('rethrows errors that are not unique violations', async () => {
      repository.insert.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.createGrant({
          ...validParams,
          idempotencyKey: 'some-key',
        }),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('getActiveCreditsMicro', () => {
    it('sums the grants that are live right now', async () => {
      const total = await service.getActiveCreditsMicro(workspaceId);

      expect(total).toBe(3_000_000);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '"billingCreditGrant"."revokedAt" IS NULL',
      );
    });

    it('returns zero when the workspace has no live grant', async () => {
      queryBuilder.getRawOne.mockResolvedValue({ total: null });

      expect(await service.getActiveCreditsMicro(workspaceId)).toBe(0);
    });
  });

  describe('closeGrantsAtPeriodEnd', () => {
    it('pulls expiries back to the period end', async () => {
      await service.closeGrantsAtPeriodEnd(
        workspaceId,
        ['grant_1'],
        EXPIRES_AT,
      );

      expect(repository.update).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ expiresAt: expect.anything() }),
        { expiresAt: EXPIRES_AT },
      );
    });

    it('does not query anything when there is no grant to close', async () => {
      await service.closeGrantsAtPeriodEnd(workspaceId, [], EXPIRES_AT);

      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('revokeGrant', () => {
    it('stamps revokedAt', async () => {
      repository.findOne.mockResolvedValue({ id: 'grant_1', revokedAt: null });

      const { wasRevokedNow } = await service.revokeGrant({
        workspaceId,
        grantId: 'grant_1',
        revokedByUserId: 'user_1',
      });

      expect(wasRevokedNow).toBe(true);
      expect(repository.update).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ id: 'grant_1' }),
        expect.objectContaining({ revokedByUserId: 'user_1' }),
      );
    });

    it('reports that it did not revoke when a concurrent call won the race', async () => {
      repository.findOne.mockResolvedValue({ id: 'grant_1', revokedAt: null });
      repository.update.mockResolvedValue({ affected: 0 });

      const { wasRevokedNow } = await service.revokeGrant({
        workspaceId,
        grantId: 'grant_1',
      });

      expect(wasRevokedNow).toBe(false);
    });

    it('leaves an already revoked grant alone', async () => {
      const revokedAt = new Date('2026-01-15T00:00:00.000Z');

      repository.findOne.mockResolvedValue({ id: 'grant_1', revokedAt });

      const { grant, wasRevokedNow } = await service.revokeGrant({
        workspaceId,
        grantId: 'grant_1',
      });

      expect(grant.revokedAt).toEqual(revokedAt);
      expect(wasRevokedNow).toBe(false);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('throws when the grant belongs to another workspace or does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.revokeGrant({ workspaceId, grantId: 'grant_unknown' }),
      ).rejects.toThrow(BillingException);
    });
  });
});
