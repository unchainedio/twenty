/* @license Enterprise */

import { isDefined } from 'twenty-shared/utils';

import { type BillingSubscriptionEntity } from 'src/engine/core-modules/billing/entities/billing-subscription.entity';
import { SubscriptionStatus } from 'src/engine/core-modules/billing/enums/billing-subscription-status.enum';

export const getBillingSubscriptionPeriod = (
  subscription: BillingSubscriptionEntity,
): { periodStart: Date; periodEnd: Date } => {
  const isTrialing =
    subscription.status === SubscriptionStatus.Trialing &&
    isDefined(subscription.trialStart) &&
    isDefined(subscription.trialEnd);

  if (isTrialing) {
    return {
      periodStart: subscription.trialStart as Date,
      periodEnd: subscription.trialEnd as Date,
    };
  }

  return {
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
  };
};
