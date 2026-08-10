import { msg } from '@lingui/core/macro';
import { type MessageDescriptor } from '@lingui/core';
import { type ThemeColor } from 'twenty-ui/theme';

import { BillingCreditGrantType } from '~/generated-admin/graphql';

export const CREDIT_GRANT_TYPE_LABELS: Record<
  BillingCreditGrantType,
  MessageDescriptor
> = {
  [BillingCreditGrantType.COMPENSATION]: msg`Compensation`,
  [BillingCreditGrantType.PARTNERSHIP]: msg`Partnership`,
  [BillingCreditGrantType.MANUAL_ADJUSTMENT]: msg`Manual adjustment`,
  [BillingCreditGrantType.ONBOARDING_REWARD]: msg`Onboarding reward`,
  [BillingCreditGrantType.ROLLOVER]: msg`Rollover`,
};

export const CREDIT_GRANT_TYPE_COLORS: Record<
  BillingCreditGrantType,
  ThemeColor
> = {
  [BillingCreditGrantType.COMPENSATION]: 'orange',
  [BillingCreditGrantType.PARTNERSHIP]: 'purple',
  [BillingCreditGrantType.MANUAL_ADJUSTMENT]: 'gray',
  [BillingCreditGrantType.ONBOARDING_REWARD]: 'blue',
  [BillingCreditGrantType.ROLLOVER]: 'green',
};

// Rollover grants are written by the period transition, so granting one by hand
// would be overwritten at the next invoice.
export const GRANTABLE_CREDIT_GRANT_TYPES: BillingCreditGrantType[] = [
  BillingCreditGrantType.COMPENSATION,
  BillingCreditGrantType.PARTNERSHIP,
  BillingCreditGrantType.MANUAL_ADJUSTMENT,
];
