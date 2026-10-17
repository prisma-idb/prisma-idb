---
"@prisma-idb/runtime-idb": minor
---

Build on Prisma 8 `8.0.0-rc.18`, whose middleware hooks are activity hooks. Replace `beforeQuery` and `beforeExecute` with `beforeEncode`, `interceptQuery` and `interceptExecute` with `intercept.onQuery` and `intercept.onExecute`, and `afterQuery` and `afterExecute` with `activityEnded`. Keep per-statement state in `ctx.state(key)` instead of `ctx.planExecutionId`. `IdbRuntimeOptions.ctx` takes `ActivityContextFields`. Statements inside `transaction()` still bypass middleware.
