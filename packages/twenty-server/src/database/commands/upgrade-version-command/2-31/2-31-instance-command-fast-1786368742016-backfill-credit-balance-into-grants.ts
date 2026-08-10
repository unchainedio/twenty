import { QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

const BACKFILL_IDEMPOTENCY_KEY_PREFIX = 'backfill-credit-balance:';

// Turns the single billingCustomer.creditBalanceMicro number into one grant per
// workspace. Deliberately fast rather than slow: available credits start being
// read from the ledger in this same release, so a workspace whose balance had
// not moved yet would report zero rollover credits and could be capped early.
// Slow commands only run behind --include-slow, which would leave that window
// open. The write is one set-based insert over one row per paying workspace, so
// it belongs on the fast path.
//
// The column keeps being written as a mirror of the ledger until it is dropped
// in a later release, so this stays reversible.
@RegisteredInstanceCommand('2.31.0', 1786368742016)
export class BackfillCreditBalanceIntoGrantsFastInstanceCommand
  implements FastInstanceCommand
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'core' AND tablename = 'billingCreditGrant'`,
    );

    if (tableExists.length === 0) {
      return;
    }

    // Expiry follows the workspace's current period, but never lands in the
    // past: a backfilled grant that expires on creation would silently delete
    // the balance it was meant to preserve.
    await queryRunner.query(
      `INSERT INTO "core"."billingCreditGrant" (
        "workspaceId", "amountMicro", "type", "effectiveAt", "expiresAt", "reason", "idempotencyKey"
      )
      SELECT
        "billingCustomer"."workspaceId",
        "billingCustomer"."creditBalanceMicro",
        'ROLLOVER',
        now(),
        GREATEST(
          COALESCE(
            (
              SELECT "billingSubscription"."currentPeriodEnd"
              FROM "core"."billingSubscription"
              WHERE "billingSubscription"."workspaceId" = "billingCustomer"."workspaceId"
                AND "billingSubscription"."status" <> 'canceled'
              ORDER BY "billingSubscription"."currentPeriodEnd" DESC
              LIMIT 1
            ),
            now()
          ),
          now() + interval '1 day'
        ),
        'Backfilled from billingCustomer.creditBalanceMicro',
        $1 || "billingCustomer"."workspaceId"
      FROM "core"."billingCustomer"
      WHERE "billingCustomer"."creditBalanceMicro" > 0
      ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [BACKFILL_IDEMPOTENCY_KEY_PREFIX],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "core"."billingCreditGrant" WHERE "idempotencyKey" LIKE $1`,
      [`${BACKFILL_IDEMPOTENCY_KEY_PREFIX}%`],
    );
  }
}
