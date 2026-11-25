# review 2026-11-25 progress

10:25Z 1 setup: worktree on review/2026-11-25 from origin/master a669cdd, primary checkout untouched
10:25Z 1 setup: npm ci done (once, root only, no wrangler)
10:26Z 2 study: arch handout at masti/cnc/work/arch/synclis.md
10:26Z 3 product pass: 7 findings, 5 references (aws backoff page came back empty, noted)
10:26Z 4 plan: docs/review-2026-11-25.md written, top 3 = empty-room hold, reconnect ladder, room-link gate + install join
10:34Z gate: coordinator asked to stop after the plan. Code for changes 1 and 2 was already written; moved to local branch wip/build-2026-11-25 (not pushed), this branch holds only the plan doc and this log
10:36Z gate: pushed review/2026-11-25 with plan doc + log only (release.yml triggers on v* tags only, so no workflow ran)
17:43Z go: cherry-picked changes 1 and 2 from wip, change 3 = his e19d5ba (install join) + link-match fix; unit 31/31 (roomlink red on old code 5 of 11)
18:01Z 8 ci: workflow review-e2e.yml (push review/** only), test/ci browser scripts written; first push next
18:08Z 8 ci run 1 green: unit 31/31, browser 17/17, shots downloaded (8 files under 60 KB). Adding a must-fail-on-master step, review doc cards
18:21Z 7 review round 1: 2 findings (service worker idle limit during retry, failed injection leaves panel) fixed in 98d1544, unit 33/33
18:25Z 7 review round 2: nothing above a nit. ci run 45674326026 green (unit 33/33, browser 17/17, master 9/17). Done pending final docs push
