/* @license Enterprise */

import { differenceInDays } from 'date-fns';
import { isDefined } from 'twenty-shared/utils';

// A trial gets a larger credit allowance when a card was provided. The two
// trial lengths are what distinguishes them on the subscription.
export const getTrialResourceCreditAllowanceMicro = ({
  trialStart,
  trialEnd,
  trialWithCreditCardDurationInDays,
  allowanceWithCreditCardMicro,
  allowanceWithoutCreditCardMicro,
}: {
  trialStart: Date | null | undefined;
  trialEnd: Date | null | undefined;
  trialWithCreditCardDurationInDays: number;
  allowanceWithCreditCardMicro: number;
  allowanceWithoutCreditCardMicro: number;
}): number => {
  const trialDurationInDays =
    isDefined(trialStart) && isDefined(trialEnd)
      ? differenceInDays(trialEnd, trialStart)
      : 0;

  return trialDurationInDays === trialWithCreditCardDurationInDays
    ? allowanceWithCreditCardMicro
    : allowanceWithoutCreditCardMicro;
};
