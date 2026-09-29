# INC-01 counterfactual

`ilab apply INC-01 --seed 42 --no-deploy` runs the identical timeline (same
seed, same fixed `errorRate`, same load) but skips the one causal step: the
deploy that removes retry backoff. Everything else - provider degradation,
traffic - is unchanged between the real and control runs.

The real run shows orders exhausting all retry attempts (`giveup` outcomes)
starting ~20s after the deploy; the control run shows zero giveups across the
same window, with zero deploys recorded for payment-service. Since the only
variable that differs is the deploy, the giveups are attributable to removing
backoff, not to the provider getting worse - `errorRate` never changes during
either run.
