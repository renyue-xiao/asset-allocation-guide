# Asset allocation guide

- Work inside this standalone repository. Keep credentials, original corpora and private user plans outside Git.
- Run `npm run check` and affected `node --test` tests after changes. API/model status must distinguish configuration, transport and answer validation.
- Monetary calculations belong in deterministic modules. Keep missing values distinct from zero; explain scenario assumptions and preserve amount conservation.
- The UI is a working planner and question-answering tool. Describe current functionality directly. Check `no-negative-echo` before publishing user-facing copy, README or PR text.
- Source retrieval is read-only and scoped to `qizhulou`. Check adjacent context and speaker attribution; report uncertain speakers rather than using metadata author as speaker.
- The development server binds loopback by default. Public deployment requires explicit authentication, quota and corpus-access design.
