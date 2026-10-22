# JavaScript source read-ahead: declined

Decision, 2026-10-22: **do not adopt; won't do**. Remove the runnable JavaScript
read-ahead experiment from the current tree. The measured performance outcome
is inconclusive, not proof of no benefit: imported-start baseline noise failed
the frozen admission gate, and empty-start confidence intervals include no gain.
Correctness passed but does not establish a reliable startup improvement.
Production never enabled this cache. Native buffering is a separate experiment.

## Source identities and method

| Snapshot | Commit |
| --- | --- |
| Current baseline | `757e5a8ae375d621bc550b4c1dd35c36542ca7ee` |
| Main-worker-only candidate, local checkpoint | `4a9ae6e4f813c48a904ac6d5c6d68edae7f4a27d` |
| Main-plus-helper candidate, local checkpoint | `70ddd45bb22074245dd17597c5ee1b005edb4d3d` |
| Prior candidate, historical only | `624e63b198e26fa28972b96442eb857ae0cf3bfb` |

Both candidates used a 256 KiB read window with a 4 MiB per-interpreter ceiling.
The baseline included the newer concurrent helper startup and memory-pressure
policy, unchanged in both candidates. Wasm SHA-256:
`fe55e387cfd9b7cf78239d39ed678e806da4ac375aa935e2d57448b7c22f71b6`.

The fixed campaign used five A/A pairs per case, then six alternating AB/BA
pairs per candidate and case: 30 calibration arms and 72 comparison arms.
Every arm launched a fresh headless Chrome process/profile against a packaged
production-format static release tree on loopback. All three trees passed the
release verifier; these were local packages, not CI-promoted release archives.
Warm measurements used a forced full reload within the same browser context.
OS/server caches could be warm; this does not measure WAN download or cold disk.
Timing excluded semantic probes, response rewriting and memory sampling.

The primary milestone was RAF-observed host readiness with the startup surface
removed and the imported build ready where applicable. It is not GPU presentation
or helper readiness. Helpers were measured separately. Imported cases used the
public guided and Lightning Strike fixtures through the existing fragment path.

## Noise and paired results

The frozen noise estimate was `max(0.03, max(abs(log(B/A))))` over each cell's
five A/A pairs. A value above 0.10 failed timing admission. No threshold was
lowered, sample count extended or timing outlier removed.
The frozen adoption criteria also required every cold case's geometric speed
ratio to exceed `1 + noise`, its lower paired 95% confidence bound to exceed
one, exact correctness, warm/helper/report regression within 5% or calibrated
noise, private-memory growth at most 10%, peak below 6 GiB, and no leaks.
The equivalent multiplicative margins below are descriptive `exp(noise) - 1`;
they do not replace the frozen `1 + noise` speed gate.

| Case | Cold log-noise points | Warm log-noise points | Equivalent cold multiplicative margin |
| --- | ---: | ---: | ---: |
| Empty | 6.46% | 8.66% | 6.67% |
| Guided | 10.30% | 15.34% | 10.85% |
| Lightning Strike | 13.81% | 6.35% | 14.81% |

Both imported cold cells and guided warm failed admission. The following fixed
comparisons are diagnostic evidence, not an admitted confirmation. Seconds are
arithmetic means; speed ratios are geometric means of paired baseline/candidate
ratios. Cold intervals are paired-log Student-t 95% intervals with five degrees
of freedom. Each row has its own neighboring baseline pairs.

| Case | Candidate | Cold baseline / candidate seconds | Cold speed ratio (95% CI) | Warm speed ratio |
| --- | --- | ---: | ---: | ---: |
| Empty | Main only | 1.703 / 1.583 | 1.0752 (0.9762–1.1843) | 1.0897 |
| Empty | Main + helpers | 1.729 / 1.608 | 1.0746 (0.9820–1.1759) | 1.0710 |
| Guided | Main only | 2.524 / 2.405 | 1.0507 (0.9642–1.1450) | 1.1107 |
| Guided | Main + helpers | 2.607 / 2.386 | 1.0948 (1.0449–1.1471) | 1.1722 |
| Lightning Strike | Main only | 3.600 / 3.267 | 1.1013 (1.0574–1.1470) | 1.0515 |
| Lightning Strike | Main + helpers | 3.646 / 3.298 | 1.1036 (1.0371–1.1744) | 1.0564 |

Host CPU reached roughly 60–75% during inspected arms, with more than 21 GiB
free RAM. Variation spanned Lua initialization and import; Wasm initialization
was comparatively stable at about 15–18 ms. CPU includes the browser itself,
so unrelated contention is not established as the cause. Causal noise remains
unresolved. The prior independent confirmation was also inconclusive: 1.0627x
aggregate speed against an 11.59% noise margin. Its 12–15% discovery gains and
the older roughly 6% engine result do not transfer to this baseline.

Evaluator corrections preceded valid measurements: a warm-navigation smoke
exposed reused marks from fragment navigation, fixed by an explicit reload.
Invalid observations were retained separately and excluded. Resource-only
response routing initially lost worker headers; preserving them fixed readiness.
Those failed diagnostic runs were retained and were never latency evidence.

## Correctness and regressions

Seven candidate file-read tests and three additional tests passed, including
2,000 seeded offset/length combinations, seeks/EOF, underlying view offsets,
returned-buffer ownership and transfer/detachment, authorization/path/mode
exclusions, bounded retention, descriptor reuse, all mutation invalidations
including failures, failed closes, cleanup and malformed transport rejection.

Both imported fixtures had exact typed MAIN/CALCS and canonical-export parity
across all three arms, including character-level edits and restoration.
Guided depth-5 Hit DPS Power Report had exact full-report and heatmap parity.
Two runs per arm in baseline/main/all/all/main/baseline order averaged
3,548.86 / 3,589.58 / 3,529.68 ms: main +1.15%, all -0.54% versus baseline.
Heroic Tragedy hover/edit checks passed exact tooltip, edit and reimport/export
parity; mean hover-to-flushed-frame times were 41.45 / 40.32 / 40.96 ms.
These small regression samples do not establish latency non-inferiority.

Historical campaign validation passed: public check; Node 207 passed, 22 skipped;
Deno 167 passed, three ignored; all three package verifiers; five packaged
all-workers release acceptance tests with retries disabled.

## Resource tradeoffs

One separate browser run per arm/case sampled whole-browser Windows private
commit, including descendants, at nominal 250 ms. Counters below are the settled
warm snapshot with all three helpers ready. RPC bytes include all binary RPC
responses, not HTTP traffic. These single runs cannot prove a memory improvement;
sampling can miss short peaks.

| Case | Arm | Peak MiB | Broker reads | Binary RPC bytes | Sum of peak cache bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| Empty | Baseline | 1950.97 | 19571 | 159603362 | 0 |
| Empty | Main | 1916.31 | 15406 | 160156324 | 262144 |
| Empty | All | 1879.75 | 1468 | 161815210 | 1048576 |
| Guided | Baseline | 2158.50 | 20130 | 165531219 | 0 |
| Guided | Main | 2156.74 | 15485 | 166084181 | 262144 |
| Guided | All | 2150.13 | 1547 | 167743067 | 1048576 |
| Lightning Strike | Baseline | 2369.35 | 20186 | 172337979 | 0 |
| Lightning Strike | Main | 2525.85 | 15509 | 173996865 | 262144 |
| Lightning Strike | All | 2370.08 | 1571 | 175655751 | 1048576 |

Settled cache bytes, cached files and tracked active descriptors were zero.
Binary over-read was +0.33–0.96% for main-only and +1.34–1.93% for all workers.
Main-only Lightning peak memory rose 6.60%; all-workers rose 0.03%. This pass
stayed within the +10% and 6 GiB gates. Forced memory-pressure admission and
helper retirement were not independently exercised.

Mean cold helper boot was 1.30–1.35 s baseline, 1.27–1.28 s main-only and
1.07–1.10 s all-workers. This suggests a helper-specific effect; it does not
establish an additional end-to-end gain because candidates were not directly
paired against each other.

## Disposition and evidence retention

Retire the cache module, its tests and runnable read-ahead variants. Keep the
pass-through transport accounting needed by independent native/bytecode
experiments. The original prototype remains recoverable from the baseline
commit above; historical results remain documented. Exact local candidate
checkpoints, patches, raw paired observations, frozen criteria, evaluator,
packaged trees and reproduction commands are retained in the investigation
archive. Local candidate commits are not promised to exist in the public remote.

Reopening requires a changed premise and a newly authorized bounded campaign
that first passes timing admission, diagnoses scheduling noise, covers broader
imports and forced memory pressure, and adequately samples report/interaction
regressions. There is no pending production integration or automatic retry.
